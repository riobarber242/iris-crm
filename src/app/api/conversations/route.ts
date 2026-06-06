import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { getSessionAgent } from '@/lib/current-agent';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  const search = url.searchParams.get('search');

  // Los agentes solo ven los chats asignados a ellos; el admin ve todo.
  const session = await getSessionAgent();
  if (!session) {
    return new NextResponse('No autenticado', { status: 401 });
  }

  let query = supabaseAdmin
    .from('contacts')
    .select('*, messages!inner(*)')
    .order('created_at', { ascending: false })
    .order('created_at', { foreignTable: 'messages', ascending: false });
  if (session.role !== 'admin') {
    query = query.eq('assigned_agent_id', session.sub);
  }
  if (status) {
    query = query.eq('status', status);
  }
  if (search) {
    query = query.ilike('name', `%${search}%`).or(`phone.ilike.%${search}%`);
  }

  const { data, error } = await query;
  if (error) {
    return new NextResponse(error.message, { status: 500 });
  }

  // Sort contacts by their most recent message DESC.
  // messages[0] is already the latest per contact (ordered by foreignTable above).
  const sorted = (data ?? []).sort((a: any, b: any) => {
    const aTs = a.messages?.[0]?.created_at ?? a.created_at;
    const bTs = b.messages?.[0]?.created_at ?? b.created_at;
    return new Date(bTs).getTime() - new Date(aTs).getTime();
  });

  return NextResponse.json(sorted);
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

  // Un agente solo puede tocar contactos asignados a él.
  if (session.role !== 'admin') {
    const { data: owned } = await supabaseAdmin
      .from('contacts')
      .select('assigned_agent_id')
      .eq('id', contactId)
      .single();
    if (!owned || owned.assigned_agent_id !== session.sub) {
      return new NextResponse('Sin acceso a este contacto', { status: 403 });
    }
  }

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

  const { data, error } = await supabaseAdmin.from('contacts').update(updates).eq('id', contactId).select('*').single();
  if (error) {
    return new NextResponse(error.message, { status: 500 });
  }

  return NextResponse.json(data);
}
