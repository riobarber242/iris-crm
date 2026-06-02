import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { sendWhatsAppImage } from '@/lib/meta/client';

export const config = { api: { bodyParser: false } };

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const file = form.get('file') as File | null;
  const contactId = form.get('contactId') as string | null;
  const caption = ((form.get('caption') as string | null) ?? '').trim();

  if (!file || !contactId) {
    return NextResponse.json({ error: 'file y contactId requeridos' }, { status: 400 });
  }

  const { data: contact } = await supabaseAdmin
    .from('contacts')
    .select('phone')
    .eq('id', contactId)
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

  const publicUrl = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/comprobantes/${path}`;

  try {
    await sendWhatsAppImage(contact.phone, publicUrl, caption);
  } catch {
    // Image uploaded but WhatsApp failed — still save to DB as failed
    const { data: saved } = await supabaseAdmin
      .from('messages')
      .insert({ contact_id: contactId, role: 'human', content: JSON.stringify({ _type: 'image', url: publicUrl, caption }), status: 'failed' })
      .select()
      .single();
    return NextResponse.json(saved ?? {}, { status: 500 });
  }

  const { data: saved, error: dbError } = await supabaseAdmin
    .from('messages')
    .insert({ contact_id: contactId, role: 'human', content: JSON.stringify({ _type: 'image', url: publicUrl, caption }), status: 'sent' })
    .select()
    .single();

  if (dbError) {
    return NextResponse.json({ error: dbError.message }, { status: 500 });
  }

  return NextResponse.json(saved, { status: 201 });
}
