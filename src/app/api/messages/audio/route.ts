import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { getSessionAgent } from '@/lib/current-agent';
import { sendWhatsAppAudio } from '@/lib/meta/client';

const MIME_TO_EXT: Record<string, string> = {
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/amr': 'amr',
  'audio/webm': 'webm',
};

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

    // Determine extension from MIME type (strip codec params for lookup)
    const baseMime = file.type.split(';')[0].trim();
    const ext = MIME_TO_EXT[baseMime] ?? 'ogg';
    const path = `operator-audio/${contactId}/${Date.now()}.${ext}`;
    const buffer = Buffer.from(await file.arrayBuffer());

    const { error: uploadError } = await supabaseAdmin.storage
      .from('comprobantes')
      .upload(path, buffer, { contentType: baseMime, upsert: true });

    if (uploadError) {
      return NextResponse.json({ error: uploadError.message }, { status: 500 });
    }

    const publicUrl = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/comprobantes/${path}`;
    const content = JSON.stringify({ _type: 'audio', url: publicUrl });

    let whatsappStatus: 'sent' | 'failed' = 'sent';
    try {
      await sendWhatsAppAudio(contact.phone, publicUrl, session.tenant_id, contact.whatsapp_number_id);
    } catch {
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
