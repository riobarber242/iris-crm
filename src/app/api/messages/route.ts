import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { sendWhatsAppText } from '@/lib/meta/client';
import { getSessionAgent } from '@/lib/current-agent';

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

  // Atribución: quién envía el mensaje (derivado de la cookie de sesión, no del cliente)
  const session = await getSessionAgent();

  const { data: inserted, error: insertError } = await supabaseAdmin.from('messages').insert({
    contact_id: contactId,
    role: 'human',
    content,
    agent_id:   session?.sub  ?? null,
    agent_name: session?.name ?? null,
  }).select('*').single();

  if (insertError || !inserted) {
    console.error('Insert message error', insertError);
    return new NextResponse('Error guardando mensaje', { status: 500 });
  }

  try {
    await sendWhatsAppText(contact.phone, content);
    if (inserted?.id) {
      await supabaseAdmin.from('messages').update({ status: 'sent' }).eq('id', inserted.id);
    }
  } catch (err) {
    console.error('Error sending manual message:', err);
    if (inserted?.id) {
      await supabaseAdmin.from('messages').update({ status: 'failed' }).eq('id', inserted.id);
    }
  }

  const { data, error } = await supabaseAdmin.from('messages').select('*').eq('id', inserted?.id).single();

  if (error) {
    return new NextResponse(error.message, { status: 500 });
  }

  return NextResponse.json(data);
}
