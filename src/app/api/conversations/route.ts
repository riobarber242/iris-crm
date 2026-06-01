import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  const search = url.searchParams.get('search');

  let query = supabaseAdmin
    .from('contacts')
    .select('*, messages!inner(*)')
    .order('created_at', { ascending: false })
    .order('created_at', { foreignTable: 'messages', ascending: false });
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
  const body = await request.json();
  const contactId = body.contactId;
  const updates: Record<string, any> = {};

  if (!contactId) {
    return new NextResponse('Falta contactId', { status: 400 });
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
  if (body.markRead) {
    updates.last_read_at = new Date().toISOString();
  }

  const { data, error } = await supabaseAdmin.from('contacts').update(updates).eq('id', contactId).select('*').single();
  if (error) {
    return new NextResponse(error.message, { status: 500 });
  }

  return NextResponse.json(data);
}
