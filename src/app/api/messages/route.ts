import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { sendWhatsAppText } from '@/lib/meta/client';
import { getSessionAgent } from '@/lib/current-agent';
import type { SessionPayload } from '@/lib/session';
import { checkRateLimit } from '@/lib/ratelimit';
import { logActivity, ACTIVITY } from '@/lib/activity-log';
import { insertMessage } from '@/lib/messages';

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

// Ventana por defecto del chat. El chat pollea cada 8 s: sin tope, cada corrida
// se traía el historial COMPLETO de la conversación (el tope real lo ponía
// PostgREST en 1000 filas). Medido en prod: la peor conversación de Casino 17Star
// tiene 2407 mensajes y devolvía 572 KB / 72 KB gzip POR REQUEST, o sea 31,7 MB
// por hora y por pestaña abierta. Auditoría 08/09/2026, hallazgo 04.
const MAX_PAGE = 200;
const DEFAULT_PAGE = 50;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const contactId = url.searchParams.get('contactId');
  // Paginación keyset hacia ATRÁS (mensajes más viejos), cursor = (created_at, id)
  // del mensaje más viejo que ya tiene cargado el cliente.
  const before   = url.searchParams.get('before');
  const beforeId = url.searchParams.get('beforeId');
  const limitParam = parseInt(url.searchParams.get('limit') ?? '', 10);
  const limit = Number.isInteger(limitParam) && limitParam > 0
    ? Math.min(limitParam, MAX_PAGE)
    : DEFAULT_PAGE;

  if (!contactId) {
    return new NextResponse('Falta contactId', { status: 400 });
  }

  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });
  const denied = await guardContactAccess(session, contactId);
  if (denied) return denied;

  // Se pide la ventana MÁS RECIENTE (created_at desc + limit) y el cliente la da
  // vuelta. `id` desempata: sin él, dos mensajes con el mismo created_at (inserts
  // en lote) podrían saltearse al paginar.
  let query = supabaseAdmin
    .from('messages')
    .select('*')
    .eq('contact_id', contactId)
    .eq('tenant_id', session.tenant_id)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit);

  // Cursor keyset: estrictamente ANTERIOR al par (created_at, id) recibido.
  if (before && beforeId) {
    query = query.or(`created_at.lt.${before},and(created_at.eq.${before},id.lt.${beforeId})`);
  }

  const { data, error } = await query;

  if (error) {
    return new NextResponse(error.message, { status: 500 });
  }

  // Firma del operador: rol + avatar de quien envió cada mensaje manual
  // (role 'human') para mostrar "nombre · rol" con su foto en el chat.
  // Rol: preferimos el snapshot guardado (agent_role); para mensajes viejos
  // sin snapshot lo resolvemos en vivo. Avatar: siempre en vivo (la foto
  // actual del usuario), con supabaseAdmin para no exponer /api/agents.
  const agentIds = [
    ...new Set((data ?? [])
      .filter((m: any) => m.role === 'human' && m.agent_id)
      .map((m: any) => m.agent_id as string)),
  ];
  let roleById: Record<string, string> = {};
  let avatarById: Record<string, string | null> = {};
  if (agentIds.length) {
    const { data: ags } = await supabaseAdmin
      .from('agents')
      .select('id, role, avatar_url')
      .in('id', agentIds);
    roleById   = Object.fromEntries((ags ?? []).map((a: any) => [a.id, a.role]));
    avatarById = Object.fromEntries((ags ?? []).map((a: any) => [a.id, a.avatar_url ?? null]));
  }
  const enriched = (data ?? []).map((m: any) =>
    m.agent_id
      ? { ...m, agent_role: m.agent_role ?? roleById[m.agent_id] ?? null, agent_avatar: avatarById[m.agent_id] ?? null }
      : m,
  );

  // hasMore por conteo: si vino la página completa, asumimos que hay más atrás.
  return NextResponse.json({ messages: enriched, hasMore: enriched.length === limit });
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
      .select('phone, whatsapp_number_id')
      .eq('id', contactId)
      .eq('tenant_id', session.tenant_id)
      .single();

    if (contactError || !contact) {
      return new NextResponse('No se encontró el contacto', { status: 404 });
    }

    // Autor del mensaje (de la sesión, no del cliente): id + nombre + rol, como
    // snapshot permanente. agent_role es el snapshot del rol al momento de enviar.
    const messageRow: Record<string, any> = {
      contact_id: contactId,
      role: 'human',
      content,
      agent_id:   session?.sub  ?? null,
      agent_name: session?.name ?? null,
      agent_role: session?.role ?? null,
      tenant_id:  session.tenant_id,
    };
    let { data: inserted, error: insertError } = await insertMessage(messageRow);

    // Degradación elegante: si la columna agent_role aún no existe (migración
    // supabase-message-author-role.sql sin correr), reintentar sin ella para no
    // romper el envío. El rol igual se muestra (resuelto en vivo) y se registra.
    if (insertError && /agent_role|column|schema cache/i.test(insertError.message ?? '')) {
      const { agent_role: _omit, ...withoutRole } = messageRow;
      ({ data: inserted, error: insertError } = await insertMessage(withoutRole));
    }

    if (insertError || !inserted) {
      console.error('Insert message error', insertError);
      return new NextResponse('Error guardando mensaje', { status: 500 });
    }

    // Motivo real del fallo de WhatsApp (ventana de 24h, número inválido, etc.)
    // para mostrarlo en el chat en vez de un error genérico.
    let failureReason: string | null = null;
    try {
      const wamid = await sendWhatsAppText(contact.phone, content, session.tenant_id, contact.whatsapp_number_id);
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

// DELETE /api/messages?id=<uuid> — borra un mensaje. La pertenencia al tenant se
// valida vía el contacto (join contact_id → contacts.tenant_id), así también
// cubre mensajes viejos con messages.tenant_id en null.
export async function DELETE(request: Request) {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });

  const id = new URL(request.url).searchParams.get('id')?.trim();
  if (!id) return NextResponse.json({ error: 'Falta el id del mensaje.' }, { status: 400 });

  const { data: msg } = await supabaseAdmin
    .from('messages')
    .select('id, contact_id, contacts!inner(tenant_id)')
    .eq('id', id)
    .eq('contacts.tenant_id', session.tenant_id)
    .maybeSingle();
  if (!msg) {
    return NextResponse.json({ error: 'Mensaje no encontrado.' }, { status: 404 });
  }

  const { error } = await supabaseAdmin.from('messages').delete().eq('id', id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  await logActivity({
    session,
    action:     'message_eliminado',
    objectType: 'message',
    objectId:   id,
    details:    { contact_id: (msg as any).contact_id ?? null },
  });

  return NextResponse.json({ ok: true });
}

// PATCH /api/messages — edita el texto de un mensaje SOLO en el CRM. NO reenvía
// nada a WhatsApp: el cliente sigue viendo el mensaje original. Body { id, content }.
// Cualquier rol del tenant (admin/agent/operator) puede editar; solo mensajes del
// equipo (human/internal) y solo texto plano. La pertenencia se valida por tenant.
export async function PATCH(request: Request) {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });

  let body: any;
  try { body = await request.json(); } catch { body = {}; }
  const id   = String(body.id ?? '').trim();
  const text = String(body.content ?? '').trim();
  if (!id)   return NextResponse.json({ error: 'Falta el id del mensaje.' }, { status: 400 });
  if (!text) return NextResponse.json({ error: 'El mensaje no puede quedar vacío.' }, { status: 400 });

  // Pertenencia al tenant (join contact_id → contacts.tenant_id) + rol + contenido.
  const { data: msg } = await supabaseAdmin
    .from('messages')
    .select('id, role, content, contact_id, contacts!inner(tenant_id)')
    .eq('id', id)
    .eq('contacts.tenant_id', session.tenant_id)
    .maybeSingle();
  if (!msg) return NextResponse.json({ error: 'Mensaje no encontrado.' }, { status: 404 });

  if (msg.role !== 'human' && msg.role !== 'internal') {
    return NextResponse.json({ error: 'Solo se editan mensajes del equipo.' }, { status: 400 });
  }
  // Rechazar multimedia: el content es un JSON { _type, url } que no se edita acá.
  const cur = String(msg.content ?? '').trim();
  if (cur.startsWith('{')) {
    try {
      if (JSON.parse(cur)?._type) {
        return NextResponse.json({ error: 'No se puede editar un mensaje multimedia.' }, { status: 400 });
      }
    } catch { /* no es JSON → es texto, se puede editar */ }
  }

  const { error } = await supabaseAdmin.from('messages').update({ content: text }).eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await logActivity({
    session,
    action:     'message_editado',
    objectType: 'message',
    objectId:   id,
    details:    { contact_id: (msg as any).contact_id ?? null },
  });

  return NextResponse.json({ ok: true, content: text });
}
