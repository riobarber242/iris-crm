import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';

export async function GET() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() - 6);
  const monthStart = new Date(today);
  monthStart.setDate(today.getDate() - 29);

  const contactsToday = await supabaseAdmin
    .from('contacts')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', today.toISOString());

  const contactsWeek = await supabaseAdmin
    .from('contacts')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', weekStart.toISOString());

  const contactsMonth = await supabaseAdmin
    .from('contacts')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', monthStart.toISOString());

  const comprobantesPending = await supabaseAdmin
    .from('comprobantes')
    .select('id', { count: 'exact', head: true })
    .eq('estado', 'pendiente');

  const vipLeads = await supabaseAdmin
    .from('leads')
    .select('id', { count: 'exact', head: true })
    .eq('score', 'vip');

  const activeLeads = await supabaseAdmin
    .from('leads')
    .select('id', { count: 'exact', head: true })
    .eq('score', 'activo');

  const coldLeads = await supabaseAdmin
    .from('leads')
    .select('id', { count: 'exact', head: true })
    .eq('score', 'frio');

  const verifiedAmount = await supabaseAdmin
    .from('comprobantes')
    .select('monto', { count: 'exact' })
    .eq('estado', 'verificado');

  return NextResponse.json({
    contactsToday: contactsToday.count ?? 0,
    contactsWeek: contactsWeek.count ?? 0,
    contactsMonth: contactsMonth.count ?? 0,
    comprobantesPending: comprobantesPending.count ?? 0,
    vipLeads: vipLeads.count ?? 0,
    activeLeads: activeLeads.count ?? 0,
    coldLeads: coldLeads.count ?? 0,
    verifiedAmount: verifiedAmount.data?.reduce((sum: number, item: any) => sum + Number(item.monto ?? 0), 0) ?? 0,
  });
}
