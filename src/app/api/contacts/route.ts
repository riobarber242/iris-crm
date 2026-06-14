import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { getSessionAgent } from '@/lib/current-agent';

export async function GET(request: Request) {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });

  const url      = new URL(request.url);
  const status   = url.searchParams.get('status');
  const all      = url.searchParams.get('all') === 'true';
  const numberId = url.searchParams.get('number'); // filtro por línea de WhatsApp

  // ?all=true or ?status=X → count mode for campaign recipient estimation
  if (all || status) {
    let query = supabaseAdmin.from('contacts').select('id')
      .eq('tenant_id', session.tenant_id)
      .neq('blocked', true);
    if (status)   query = query.eq('status', status);
    if (numberId) query = query.eq('whatsapp_number_id', numberId);
    const { data, error } = await query;
    if (error) return new NextResponse(error.message, { status: 500 });
    return NextResponse.json(data ?? []);
  }

  // Default: agendados (with casino_username) for /contacts page
  const { data, error } = await supabaseAdmin
    .from('contacts')
    .select('id, phone, status, casino_username, whatsapp_number_id, created_at')
    .eq('tenant_id', session.tenant_id)
    .not('casino_username', 'is', null)
    .neq('casino_username', '')
    .order('created_at', { ascending: false });

  if (error) return new NextResponse(error.message, { status: 500 });
  return NextResponse.json(data ?? []);
}
