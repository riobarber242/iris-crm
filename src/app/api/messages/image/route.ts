import { after, NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { getSessionAgent } from '@/lib/current-agent';
import { sendWhatsAppImage } from '@/lib/meta/client';
import { insertMessage } from '@/lib/messages';
import { makeThumb, thumbPathFor } from '@/lib/thumb-generate';

export async function POST(req: NextRequest) {
  try {
    const session = await getSessionAgent();
    if (!session) return new NextResponse('No autenticado', { status: 401 });

    const form = await req.formData();
    const file = form.get('file') as File | null;
    const contactId = form.get('contactId') as string | null;
    const caption = ((form.get('caption') as string | null) ?? '').trim();

    if (!file || !contactId) {
      return NextResponse.json({ error: 'file y contactId requeridos' }, { status: 400 });
    }

    const { data: contact } = await supabaseAdmin
      .from('contacts')
      .select('phone, whatsapp_number_id')
      .eq('id', contactId)
      .eq('tenant_id', session.tenant_id)
      .single();

    if (!contact) {
      return NextResponse.json({ error: 'Contacto no encontrado' }, { status: 404 });
    }

    // Upload to Supabase Storage
    const ext = (file.type.split('/')[1] ?? 'jpg').replace('jpeg', 'jpg');
    const path = `operator/${contactId}/${Date.now()}.${ext}`;
    const buffer = Buffer.from(await file.arrayBuffer());

    const { error: uploadError } = await supabaseAdmin.storage
      .from('comprobantes')
      .upload(path, buffer, { contentType: file.type, upsert: true });

    if (uploadError) {
      return NextResponse.json({ error: uploadError.message }, { status: 500 });
    }

    // Thumb pre-generado (best-effort, FUERA del camino de respuesta): un webp chico
    // sibling del original para servir como objeto estático en vez de pedir la
    // transformación al vuelo. after() lo corre una vez enviada la respuesta —Vercel
    // mantiene viva la función hasta que termina— así no suma latencia al envío. Si
    // falla, seguimos sin thumb (el front cae al original vía onError).
    // Ver src/lib/thumb-generate.ts.
    after(async () => {
      try {
        const thumb = await makeThumb(buffer);
        if (thumb) {
          await supabaseAdmin.storage
            .from('comprobantes')
            .upload(thumbPathFor(path), thumb, { contentType: 'image/webp', upsert: true });
        }
      } catch (err) {
        console.warn('[messages/image] No se pudo generar/subir el thumb:', err);
      }
    });

    const publicUrl = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/comprobantes/${path}`;

    try {
      await sendWhatsAppImage(contact.phone, publicUrl, caption, session.tenant_id, contact.whatsapp_number_id);
    } catch {
      // Imagen subida pero WhatsApp falló: guardamos la fila como 'failed' y la
      // devolvemos con 207 (igual que audio). Así el cliente la reconcilia por id
      // y el evento Realtime no genera una burbuja duplicada.
      const { data: saved } = await insertMessage({
        contact_id: contactId, role: 'human', content: JSON.stringify({ _type: 'image', url: publicUrl, caption }), status: 'failed', tenant_id: session.tenant_id,
      });
      return NextResponse.json(saved ?? {}, { status: 207 });
    }

    const { data: saved, error: dbError } = await insertMessage({
      contact_id: contactId, role: 'human', content: JSON.stringify({ _type: 'image', url: publicUrl, caption }), status: 'sent', tenant_id: session.tenant_id,
    });

    if (dbError) {
      return NextResponse.json({ error: dbError.message }, { status: 500 });
    }

    return NextResponse.json(saved, { status: 201 });
  } catch (err: any) {
    console.error('[messages/image POST] Error inesperado:', err);
    return NextResponse.json({ error: 'Error interno enviando la imagen' }, { status: 500 });
  }
}
