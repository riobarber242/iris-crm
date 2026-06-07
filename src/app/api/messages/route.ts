import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { sendWhatsAppText } from '@/lib/meta/client';
import { getSessionAgent } from '@/lib/current-agent';
import type { SessionPayload } from '@/lib/session';
import { checkRateLimit } from '@/lib/ratelimit';

// Un agente solo puede acceder a un contacto asignado a él; el admin, a todos.
// Devuelve null si tiene acceso, o una NextResponse de error si no.
async function guardContactAccess(
  session: SessionPayload,
  contactId: string,
): Promise<NextResponse | null> {
  // Scope por tenant para TODOS los roles (incluye admin → no cruza tenants).
  const { data } = await supabaseAdmin
    .from('contacts')
    .select('assigned_agent_id')
    .eq('id', contactId)
    .eq('tenant_id', session.tenant_id)
    .maybeSingle();
  if (!data) return new NextResponse('Sin acceso a este contacto', { status: 403 });
  if (session.role !== 'admin' && data.assigned_agent_id !== session.sub) {
    return new NextResponse('Sin acceso a este contacto', { status: 403 });
  }
  return null;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const contactId = url.searchParams.get('contactId');

  if (!contactId) {
    return new NextResponse('Falta contactId', { status: 400 });
  }

  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });
  const denied = await guardContactAccess(session, contactId);
  if (denied) return denied;

  const { data, error } = await supabaseAdmin
    .from('messages')
    .select('*')
    .eq('contact_id', contactId)
    .eq('tenant_id', session.tenant_id)
    .order('created_at', { ascending: false });

  if (error) {
    return new NextResponse(error.message, { status: 500 });
  }

  return NextResponse.json(data);
}

export async function POST(request: Request) {
  const limited = checkRateLimit(request, 'messages', 60);
  if (limited) return limited;

  try {
    const body = await request.json().catch(() => null);
    if (!body) {
      return NextResponse.json({ error: 'JSON inválido en el body' }, { status: 400 });
    }
    const contactId = body.contactId;
    const content = body.content;

    if (!contactId || !content) {
      return new NextResponse('Faltan contactId o content', { status: 400 });
    }

    // Atribución: quién envía el mensaje (derivado de la cookie de sesión, no del cliente)
    const session = await getSessionAgent();
    if (!session) return new NextResponse('No autenticado', { status: 401 });
    const denied = await guardContactAccess(session, contactId);
    if (denied) return denied;

    const { data: contact, error: contactError } = await supabaseAdmin
      .from('contacts')
      .select('phone')
      .eq('id', contactId)
      .eq('tenant_id', session.tenant_id)
      .single();

    if (contactError || !contact) {
      return new NextResponse('No se encontró el contacto', { status: 404 });
    }

    const { data: inserted, error: insertError } = await supabaseAdmin.from('messages').insert({
      contact_id: contactId,
      role: 'human',
      content,
      agent_id:   session?.sub  ?? null,
      agent_name: session?.name ?? null,
      tenant_id:  session.tenant_id,
    }).select('*').single();

    if (insertError || !inserted) {
      console.error('Insert message error', insertError);
      return new NextResponse('Error guardando mensaje', { status: 500 });
    }

    try {
      const wamid = await sendWhatsAppText(contact.phone, content);
      if (inserted?.id) {
        await supabaseAdmin.from('messages')
          .update({ status: 'sent', whatsapp_message_id: wamid })
          .eq('id', inserted.id);
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
  } catch (err: any) {
    console.error('[messages POST] Error inesperado:', err);
    return NextResponse.json({ error: 'Error interno enviando el mensaje' }, { status: 500 });
  }
}
