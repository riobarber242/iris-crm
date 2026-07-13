import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { getSessionAgent } from '@/lib/current-agent';
import { makeThumb, thumbPathFor } from '@/lib/thumb-generate';

// Backfill one-off de los thumbnails de imágenes YA existentes (las subidas antes
// de que los 6 uploads generaran el .thumb.webp). Sin esto, tras el cutover del
// front (parte 5) las imágenes viejas caerían al original full-res (egress) hasta
// re-subirlas. Genera el thumb con sharp (NO usa render/image) → cero transforms.
//
// Uso (solo admin, scopeado a su tenant). Se llama por lotes y se re-llama con el
// nextCursor hasta que venga null, una fuente por vez:
//   POST /api/admin/backfill-thumbs?source=comprobantes&limit=100
//   POST /api/admin/backfill-thumbs?source=messages&limit=100&cursor=<created_at>
//   ... source ∈ comprobantes | messages | internal | avatars
//
// Idempotente/resumable: si el thumb ya existe, saltea. upsert:true.

export const maxDuration = 300; // lotes de descargas+resize; Pro permite hasta 300s

const PUBLIC_MARKER = '/storage/v1/object/public/';
const CONCURRENCY = 5;

// URL pública → { bucket, path } | null si no es un objeto de Storage público.
function parsePublicUrl(url: string): { bucket: string; path: string } | null {
  const i = url.indexOf(PUBLIC_MARKER);
  if (i < 0) return null;
  const rest = url.slice(i + PUBLIC_MARKER.length); // <bucket>/<path...>
  const slash = rest.indexOf('/');
  if (slash < 0) return null;
  return { bucket: rest.slice(0, slash), path: decodeURIComponent(rest.slice(slash + 1)) };
}

function isRaster(path: string): boolean {
  return /\.(jpe?g|png|webp|gif)$/i.test(path);
}

type Outcome = 'done' | 'skip' | 'error';

// Genera+sube el thumb de una URL pública si falta.
async function ensureThumb(url: string | null | undefined): Promise<Outcome> {
  if (!url) return 'skip';
  const loc = parsePublicUrl(url);
  if (!loc || !isRaster(loc.path)) return 'skip'; // externa, PDF, u otro
  const thumbPath = thumbPathFor(loc.path);
  const dir       = loc.path.includes('/') ? loc.path.slice(0, loc.path.lastIndexOf('/')) : '';
  const thumbName = thumbPath.slice(thumbPath.lastIndexOf('/') + 1);
  try {
    // ¿Ya existe el thumb? → saltear (resume/re-run barato).
    const { data: existing } = await supabaseAdmin.storage.from(loc.bucket).list(dir, { search: thumbName, limit: 1 });
    if (existing?.some((f: { name: string }) => f.name === thumbName)) return 'skip';

    // Bajar el original, redimensionar, subir el thumb.
    const { data: orig, error: dlErr } = await supabaseAdmin.storage.from(loc.bucket).download(loc.path);
    if (dlErr || !orig) return 'error';
    const thumb = await makeThumb(Buffer.from(await orig.arrayBuffer()));
    if (!thumb) return 'skip'; // no era raster procesable
    const { error: upErr } = await supabaseAdmin.storage.from(loc.bucket)
      .upload(thumbPath, thumb, { contentType: 'image/webp', upsert: true });
    return upErr ? 'error' : 'done';
  } catch {
    return 'error';
  }
}

// Corre las tareas con concurrencia acotada y agrega los resultados.
async function runPool(urls: (string | null | undefined)[]): Promise<Record<Outcome, number>> {
  const tally: Record<Outcome, number> = { done: 0, skip: 0, error: 0 };
  for (let i = 0; i < urls.length; i += CONCURRENCY) {
    const chunk = urls.slice(i, i + CONCURRENCY);
    const outs = await Promise.all(chunk.map((u) => ensureThumb(u)));
    for (const o of outs) tally[o]++;
  }
  return tally;
}

// Extrae la url de un content de mensaje ({_type:'image', url}); null si no aplica.
function imageUrlFromContent(content: string | null): string | null {
  if (!content) return null;
  try {
    const p = JSON.parse(content);
    return p?._type === 'image' && typeof p.url === 'string' ? p.url : null;
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  const session = await getSessionAgent();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (session.role !== 'admin') return NextResponse.json({ error: 'Solo admin' }, { status: 403 });

  const { searchParams } = new URL(req.url);
  const source = searchParams.get('source') ?? 'comprobantes';
  const limit  = Math.min(Math.max(Number(searchParams.get('limit') ?? 100), 1), 500);
  const cursor = searchParams.get('cursor'); // created_at ISO del último procesado
  const tid    = session.tenant_id;

  let urls: (string | null)[] = [];
  let nextCursor: string | null = null;

  if (source === 'avatars') {
    // Tabla chica: sin cursor, todos los avatares del tenant de una.
    const { data, error } = await supabaseAdmin
      .from('agents').select('avatar_url').eq('tenant_id', tid).not('avatar_url', 'is', null);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    urls = (data ?? []).map((r: any) => r.avatar_url);
  } else if (source === 'comprobantes') {
    let q = supabaseAdmin
      .from('comprobantes').select('image_url, created_at')
      .eq('tenant_id', tid).not('image_url', 'is', null);
    if (cursor) q = q.lt('created_at', cursor);
    const { data, error } = await q.order('created_at', { ascending: false }).limit(limit);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    urls = (data ?? []).map((r: any) => r.image_url);
    if ((data?.length ?? 0) === limit) nextCursor = data![data!.length - 1].created_at;
  } else if (source === 'messages' || source === 'internal') {
    const table = source === 'messages' ? 'messages' : 'internal_messages';
    let q = supabaseAdmin
      .from(table).select('content, created_at')
      .eq('tenant_id', tid).like('content', '%"_type":"image"%');
    if (cursor) q = q.lt('created_at', cursor);
    const { data, error } = await q.order('created_at', { ascending: false }).limit(limit);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    urls = (data ?? []).map((r: any) => imageUrlFromContent(r.content));
    if ((data?.length ?? 0) === limit) nextCursor = data![data!.length - 1].created_at;
  } else {
    return NextResponse.json({ error: `source inválido: ${source}` }, { status: 400 });
  }

  const tally = await runPool(urls);
  return NextResponse.json({
    source,
    procesados: urls.length,
    conThumb:   tally.done,
    saltados:   tally.skip,
    errores:    tally.error,
    nextCursor,
  });
}
