import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { getSessionAgent } from '@/lib/current-agent';
import { sendWhatsAppAudio } from '@/lib/meta/client';
import { toOggOpus } from '@/lib/audio/toOggOpus';

export async function POST(req: NextRequest) {
  try {
    const session = await getSessionAgent();
    if (!session) return new NextResponse('No autenticado', { status: 401 });

    const form = await req.formData();
    const file = form.get('file') as File | null;
    const contactId = form.get('contactId') as string | null;

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

    const baseMime = file.type.split(';')[0].trim();
    const rawBuffer = Buffer.from(await file.arrayBuffer());

    // WhatsApp solo entrega notas de voz en OGG/Opus. El navegador graba en
    // webm/opus (Chrome no graba ogg), así que remuxeamos a ogg/opus antes de
    // enviar. Si ya viene en ogg (Firefox) se saltea. Si el remux falla, se
    // corta con error visible: mandar webm igual no se entrega (un solo tilde).
    let audioBuffer: Buffer = rawBuffer;
    if (baseMime !== 'audio/ogg') {
      try {
        audioBuffer = await toOggOpus(rawBuffer);
      } catch (err) {
        console.error('[messages/audio] remux a ogg/opus falló:', err);
        return NextResponse.json({ error: 'No se pudo convertir el audio a formato compatible.' }, { status: 500 });
      }
    }

    const path = `operator-audio/${contactId}/${Date.now()}.ogg`;

    const { error: uploadError } = await supabaseAdmin.storage
      .from('comprobantes')
      .upload(path, audioBuffer, { contentType: 'audio/ogg', upsert: true });

    if (uploadError) {
      return NextResponse.json({ error: uploadError.message }, { status: 500 });
    }

    const publicUrl = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/comprobantes/${path}`;
    const content = JSON.stringify({ _type: 'audio', url: publicUrl });

    console.log(`[messages/audio] enviando a ${contact.phone} url=${publicUrl} mimeOriginal=${baseMime} → ogg/opus`);

    let whatsappStatus: 'sent' | 'failed' = 'sent';
    try {
      await sendWhatsAppAudio(contact.phone, publicUrl, session.tenant_id, contact.whatsapp_number_id);
    } catch (err) {
      console.error('[messages/audio] sendWhatsAppAudio falló:', err);
      whatsappStatus = 'failed';
    }

    const { data: saved, error: dbError } = await supabaseAdmin
      .from('messages')
      .insert({ contact_id: contactId, role: 'human', content, status: whatsappStatus, tenant_id: session.tenant_id })
      .select()
      .single();

    if (dbError) {
      return NextResponse.json({ error: dbError.message }, { status: 500 });
    }

    return NextResponse.json(saved, { status: whatsappStatus === 'sent' ? 201 : 207 });
  } catch (err: any) {
    console.error('[messages/audio POST] Error inesperado:', err);
    return NextResponse.json({ error: 'Error interno enviando el audio' }, { status: 500 });
  }
}
