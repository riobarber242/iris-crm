import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';

export async function GET(request: Request) {
  const url    = new URL(request.url);
  const status = url.searchParams.get('status');
  const all    = url.searchParams.get('all') === 'true';

  // ?all=true or ?status=X → count mode for campaign recipient estimation
  if (all || status) {
    let query = supabaseAdmin.from('contacts').select('id').neq('blocked', true);
    if (status) query = query.eq('status', status);
    const { data, error } = await query;
    if (error) return new NextResponse(error.message, { status: 500 });
    return NextResponse.json(data ?? []);
  }

  // Default: agendados (with casino_username) for /contacts page
  const { data, error } = await supabaseAdmin
    .from('contacts')
    .select('id, phone, status, casino_username, created_at')
    .not('casino_username', 'is', null)
    .neq('casino_username', '')
    .order('created_at', { ascending: false });

  if (error) return new NextResponse(error.message, { status: 500 });
  return NextResponse.json(data ?? []);
}
