import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { sendWhatsAppText } from '@/lib/meta/client';
import { getSessionAgent } from '@/lib/current-agent';
import type { SessionPayload } from '@/lib/session';
import { checkRateLimit } from '@/lib/ratelimit';
import { logActivity, ACTIVITY } from '@/lib/activity-log';

// Acceso por TENANT: admin, agente y operador acceden a cualquier contacto de
// su tenant (la asignación no restringe). Devuelve null si tiene acceso, o una
// NextResponse de error si no.
async function guardContactAccess(
  session: SessionPayload,
  contactId: string,
): Promise<NextResponse | null> {
  const { data } = await supabaseAdmin
    .from('contacts')
    .select('id')
    .eq('id', contactId)
    .eq('tenant_id', session.tenant_id)
    .maybeSingle();
  if (!data) return new NextResponse('Sin acceso a este contacto', { status: 403 });
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

  // Firma del operador: adjuntar el rol de quien envió cada mensaje manual
  // (role 'human') para mostrar "nombre · rol" en el chat. Se resuelve acá con
  // supabaseAdmin para no exponer /api/agents a los operadores.
  const agentIds = [
    ...new Set((data ?? [])
      .filter((m: any) => m.role === 'human' && m.agent_id)
      .map((m: any) => m.agent_id as string)),
  ];
  let roleById: Record<string, string> = {};
  if (agentIds.length) {
    const { data: ags } = await supabaseAdmin
      .from('agents')
      .select('id, role')
      .in('id', agentIds);
    roleById = Object.fromEntries((ags ?? []).map((a: any) => [a.id, a.role]));
  }
  const enriched = (data ?? []).map((m: any) =>
    m.agent_id ? { ...m, agent_role: roleById[m.agent_id] ?? null } : m,
  );

  return NextResponse.json(enriched);
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

    // Motivo real del fallo de WhatsApp (ventana de 24h, número inválido, etc.)
    // para mostrarlo en el chat en vez de un error genérico.
    let failureReason: string | null = null;
    try {
      const wamid = await sendWhatsAppText(contact.phone, content, session.tenant_id);
      if (inserted?.id) {
        await supabaseAdmin.from('messages')
          .update({ status: 'sent', whatsapp_message_id: wamid })
          .eq('id', inserted.id);
      }
    } catch (err: any) {
      failureReason =
        err?.response?.data?.error?.message ||
        err?.message ||
        'WhatsApp rechazó el envío';
      console.error('Error sending manual message:', err);
      if (inserted?.id) {
        await supabaseAdmin.from('messages').update({ status: 'failed' }).eq('id', inserted.id);
      }
    }

    const { data, error } = await supabaseAdmin.from('messages').select('*').eq('id', inserted?.id).single();

    if (error) {
      return new NextResponse(error.message, { status: 500 });
    }

    // Registro de actividad: el operador/agente respondió la conversación.
    await logActivity({
      session,
      action:     ACTIVITY.MESSAGE_SENT,
      objectType: 'conversation',
      objectId:   contactId,
      details:    { message_id: inserted?.id ?? null, status: data?.status ?? null, failed: !!failureReason },
    });

    return NextResponse.json(failureReason ? { ...data, error: failureReason } : data);
  } catch (err: any) {
    console.error('[messages POST] Error inesperado:', err);
    return NextResponse.json({ error: 'Error interno enviando el mensaje' }, { status: 500 });
  }
}
