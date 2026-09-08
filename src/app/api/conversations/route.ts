import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { getSessionAgent } from '@/lib/current-agent';
import { logActivity, ACTIVITY } from '@/lib/activity-log';

// Tope duro de filas por página. El cliente pide 50; 200 es el máximo que se acepta
// aunque lo pidan más grande, para que nadie pueda volver a traerse la lista entera
// por query string (mismo criterio que la bandeja de comprobantes).
const MAX_PAGE = 200;
const DEFAULT_PAGE = 50;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  const search = url.searchParams.get('search');
  // Filtro "No leídos". La RPC aplica un pre-filtro conservador y el cliente
  // termina con classifyPending (ver la NOTA en supabase-conversations-list-paginado.sql).
  const unreadOnly = url.searchParams.get('unread') === '1';
  // Paginación keyset: cursor = (created_at, id) del último item de la página previa.
  const before   = url.searchParams.get('before');   // ISO created_at del último mensaje
  const beforeId = url.searchParams.get('beforeId'); // uuid, desempate del cursor
  const limitParam = parseInt(url.searchParams.get('limit') ?? '', 10);
  const limit = Number.isInteger(limitParam) && limitParam > 0
    ? Math.min(limitParam, MAX_PAGE)
    : DEFAULT_PAGE;

  // Todos los roles internos (admin, agente, operador) ven TODAS las
  // conversaciones de su tenant. La asignación es informativa, no filtra.
  const session = await getSessionAgent();
  if (!session) {
    return new NextResponse('No autenticado', { status: 401 });
  }

  // Fix de EGRESS #1: en vez de traer el historial COMPLETO de mensajes de cada
  // contacto (`select('*, messages!inner(*)')`), la RPC devuelve por contacto solo
  // el ÚLTIMO mensaje (en `messages` como array de 1, para no romper el frontend) y
  // `pending_count` (entrantes sin leer, para el badge).
  //
  // Fix de EGRESS #2 (auditoría 08/09/2026): además ahora PAGINA. Antes devolvía las
  // 857 conversaciones del tenant en cada llamada (691 KB, ~1 s) y eso se disparaba
  // con cada evento de Realtime. Ver supabase-conversations-list-paginado.sql.
  const { data, error } = await supabaseAdmin.rpc('fn_conversations_list', {
    p_tenant_id:   session.tenant_id,
    p_status:      status || null,
    p_search:      search || null,
    p_unread_only: unreadOnly,
    p_limit:       limit,
    p_before_at:   before   || null,
    p_before_id:   beforeId || null,
  });
  if (error) {
    return new NextResponse(error.message, { status: 500 });
  }

  // La función devuelve una fila por contacto con una única columna `row` (el JSON
  // ya armado: contacto + messages:[último] + pending_count).
  const conversations = (data ?? []).map((r: any) => r.row);

  // `hasMore` por conteo: si vino la página completa, asumimos que hay más. Evita el
  // COUNT(*) sobre la lista entera, que era justo el costo que estamos sacando.
  return NextResponse.json({
    conversations,
    hasMore: conversations.length === limit,
  });
}

export async function PATCH(request: Request) {
  const session = await getSessionAgent();
  if (!session) {
    return new NextResponse('No autenticado', { status: 401 });
  }

  const body = await request.json();
  const contactId = body.contactId;
  const updates: Record<string, any> = {};

  if (!contactId) {
    return new NextResponse('Falta contactId', { status: 400 });
  }

  // Acceso por tenant: todos los roles internos pueden editar cualquier
  // contacto de su tenant. El UPDATE final filtra por tenant_id, así que no
  // se puede tocar un contacto de otro tenant.

  // La asignación de operador es exclusiva del admin.
  if (body.assigned_agent_id !== undefined) {
    if (session.role !== 'admin') {
      return new NextResponse('Solo el admin puede asignar operadores', { status: 403 });
    }
    updates.assigned_agent_id = body.assigned_agent_id || null;
  }

  if (body.status) {
    updates.status = body.status;
  }
  if (body.name !== undefined) {
    updates.name = body.name;
  }
  if (body.blocked !== undefined) {
    updates.blocked = body.blocked;
  }
  if (body.joined_channel !== undefined) {
    updates.joined_channel = body.joined_channel;
  }
  if (body.casino_username !== undefined) {
    updates.casino_username = body.casino_username;
  }
  if (body.notes !== undefined) {
    updates.notes = body.notes;
  }
  if (body.conversation_state !== undefined) {
    updates.conversation_state = body.conversation_state;
  }
  if (body.provincia !== undefined) {
    updates.provincia = body.provincia;
  }
  if (body.markRead) {
    updates.last_read_at = new Date().toISOString();
  }

  const { data, error } = await supabaseAdmin.from('contacts').update(updates).eq('id', contactId).eq('tenant_id', session.tenant_id).select('*').single();
  if (error) {
    return new NextResponse(error.message, { status: 500 });
  }

  // Registro de actividad: edición de contacto (excluye el simple markRead,
  // que setea last_read_at sin ser una edición de datos).
  const editedFields = Object.keys(updates).filter((k) => k !== 'last_read_at');
  if (editedFields.length > 0) {
    await logActivity({
      session,
      action:     ACTIVITY.CONTACT_EDITED,
      objectType: 'contact',
      objectId:   contactId,
      details:    { fields: editedFields, ...(updates.status !== undefined ? { status: updates.status } : {}) },
    });
  }

  return NextResponse.json(data);
}
