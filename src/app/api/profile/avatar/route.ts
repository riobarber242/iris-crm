import { after, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { getSessionAgent } from '@/lib/current-agent';
import { makeThumb, thumbPathFor } from '@/lib/thumb-generate';

// POST /api/profile/avatar — subir/cambiar la foto del PROPIO perfil.
// multipart/form-data con campo "file". Valida tipo y tamaño en backend
// (el límite del bucket es la segunda barrera). Guarda en Storage
// avatars/{tenant_id}/{user_id}/ y persiste avatar_url en agents.

const BUCKET = 'avatars';
const MAX_BYTES = 2 * 1024 * 1024; // 2MB
const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png':  'png',
  'image/webp': 'webp',
};

export async function POST(request: Request) {
  const session = await getSessionAgent();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });

  let form: FormData;
  try { form = await request.formData(); } catch {
    return NextResponse.json({ error: 'Se espera multipart/form-data' }, { status: 400 });
  }
  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Falta el archivo "file"' }, { status: 400 });
  }

  const ext = EXT_BY_MIME[file.type];
  if (!ext) return NextResponse.json({ error: 'Formato no permitido. Usá JPG, PNG o WebP.' }, { status: 400 });
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: 'La imagen supera los 2MB.' }, { status: 400 });
  }
  if (file.size === 0) return NextResponse.json({ error: 'Archivo vacío' }, { status: 400 });

  const folder = `${session.tenant_id}/${session.sub}`;
  // Nombre con timestamp para evitar que el CDN sirva la foto vieja cacheada.
  const path = `${folder}/avatar-${Date.now()}.${ext}`;
  const bytes = Buffer.from(await file.arrayBuffer());

  // Borrar las fotos anteriores del usuario (best-effort, no bloquea).
  try {
    const { data: prev } = await supabaseAdmin.storage.from(BUCKET).list(folder);
    if (prev && prev.length > 0) {
      await supabaseAdmin.storage.from(BUCKET).remove(prev.map((f: { name: string }) => `${folder}/${f.name}`));
    }
  } catch { /* sin drama: el upload sigue */ }

  let { error: upErr } = await supabaseAdmin.storage.from(BUCKET)
    .upload(path, bytes, { contentType: file.type, upsert: true });

  // Si el bucket no existe (entorno nuevo), lo creamos y reintentamos una vez.
  if (upErr && /bucket/i.test(upErr.message ?? '')) {
    await supabaseAdmin.storage.createBucket(BUCKET, {
      public: true,
      fileSizeLimit: MAX_BYTES,
      allowedMimeTypes: Object.keys(EXT_BY_MIME),
    }).catch(() => {});
    ({ error: upErr } = await supabaseAdmin.storage.from(BUCKET)
      .upload(path, bytes, { contentType: file.type, upsert: true }));
  }
  if (upErr) return NextResponse.json({ error: `No se pudo subir la imagen: ${upErr.message}` }, { status: 500 });

  // Thumb pre-generado (best-effort, en after()): webp chico sibling del avatar para
  // servirlo estático en ProfileCard en vez de transformar al vuelo. El borrado de
  // fotos previas de arriba ya limpia los .thumb.webp viejos. Si falla, cae al original.
  after(async () => {
    try {
      const thumb = await makeThumb(bytes);
      if (thumb) {
        await supabaseAdmin.storage.from(BUCKET)
          .upload(thumbPathFor(path), thumb, { contentType: 'image/webp', upsert: true });
      }
    } catch (err) {
      console.warn('[profile/avatar] No se pudo generar/subir el thumb:', err);
    }
  });

  const { data: pub } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(path);
  const avatar_url = pub.publicUrl;

  const { error: dbErr } = await supabaseAdmin
    .from('agents')
    .update({ avatar_url })
    .eq('id', session.sub);
  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });

  return NextResponse.json({ ok: true, avatar_url });
}
