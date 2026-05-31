import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { sendWhatsAppText } from '@/lib/meta/client';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const contactId = url.searchParams.get('contactId');

  if (!contactId) {
    return new NextResponse('Falta contactId', { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from('messages')
    .select('*')
    .eq('contact_id', contactId)
    .order('created_at', { ascending: false });

  if (error) {
    return new NextResponse(error.message, { status: 500 });
  }

  return NextResponse.json(data);
}

export async function POST(request: Request) {
  const body = await request.json();
  const contactId = body.contactId;
  const content = body.content;

  if (!contactId || !content) {
    return new NextResponse('Faltan contactId o content', { status: 400 });
  }

  const { data: contact, error: contactError } = await supabaseAdmin
    .from('contacts')
    .select('phone')
    .eq('id', contactId)
    .single();

  if (contactError || !contact) {
    return new NextResponse('No se encontró el contacto', { status: 404 });
  }

  await sendWhatsAppText(contact.phone, content);
  const { data, error } = await supabaseAdmin.from('messages').insert({
    contact_id: contactId,
    role: 'human',
    content,
    status: 'sent',
  }).select('*').single();

  if (error) {
    return new NextResponse(error.message, { status: 500 });
  }

  return NextResponse.json(data);
}
