import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';

function countUnique(data: { contact_id: string }[]): number {
  return new Set(data.map((r) => r.contact_id)).size;
}

function sumMonto(data: { monto: number | null }[]): number {
  return data.reduce((s, r) => s + Number(r.monto ?? 0), 0);
}

export async function GET() {
  const now = new Date();

  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  // Lunes de la semana actual
  const weekStart = new Date(todayStart);
  weekStart.setDate(todayStart.getDate() - ((todayStart.getDay() + 6) % 7));

  const monthStart    = new Date(now.getFullYear(), now.getMonth(),     1);
  const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevMonthEnd   = new Date(now.getFullYear(), now.getMonth(),     1); // exclusive

  const [
    convTodayRes, convWeekRes, convMonthRes, convPrevMonthRes,
    newToday, newWeek, newMonth, newPrevMonth,
    vipLeads, activeLeads, coldLeads,
    comprobantesPending,
    montoHoyRes, montoMesRes, montoPrevRes,
  ] = await Promise.all([
    // Conversaciones — contact_ids únicos por período
    supabaseAdmin.from('messages').select('contact_id').gte('created_at', todayStart.toISOString()),
    supabaseAdmin.from('messages').select('contact_id').gte('created_at', weekStart.toISOString()),
    supabaseAdmin.from('messages').select('contact_id').gte('created_at', monthStart.toISOString()),
    supabaseAdmin.from('messages').select('contact_id')
      .gte('created_at', prevMonthStart.toISOString())
      .lt('created_at',  prevMonthEnd.toISOString()),

    // Contactos nuevos — count por período
    supabaseAdmin.from('contacts').select('id', { count: 'exact', head: true }).gte('created_at', todayStart.toISOString()),
    supabaseAdmin.from('contacts').select('id', { count: 'exact', head: true }).gte('created_at', weekStart.toISOString()),
    supabaseAdmin.from('contacts').select('id', { count: 'exact', head: true }).gte('created_at', monthStart.toISOString()),
    supabaseAdmin.from('contacts').select('id', { count: 'exact', head: true })
      .gte('created_at', prevMonthStart.toISOString())
      .lt('created_at',  prevMonthEnd.toISOString()),

    // Leads por score
    supabaseAdmin.from('leads').select('id', { count: 'exact', head: true }).eq('score', 'vip'),
    supabaseAdmin.from('leads').select('id', { count: 'exact', head: true }).eq('score', 'activo'),
    supabaseAdmin.from('leads').select('id', { count: 'exact', head: true }).eq('score', 'frio'),

    // Comprobantes pendientes
    supabaseAdmin.from('comprobantes').select('id', { count: 'exact', head: true }).eq('estado', 'pendiente'),

    // Montos verificados
    supabaseAdmin.from('comprobantes').select('monto').eq('estado', 'verificado').gte('created_at', todayStart.toISOString()),
    supabaseAdmin.from('comprobantes').select('monto').eq('estado', 'verificado').gte('created_at', monthStart.toISOString()),
    supabaseAdmin.from('comprobantes').select('monto').eq('estado', 'verificado')
      .gte('created_at', prevMonthStart.toISOString())
      .lt('created_at',  prevMonthEnd.toISOString()),
  ]);

  return NextResponse.json({
    // Conversaciones
    convToday:     countUnique(convTodayRes.data     ?? []),
    convWeek:      countUnique(convWeekRes.data       ?? []),
    convMonth:     countUnique(convMonthRes.data      ?? []),
    convPrevMonth: countUnique(convPrevMonthRes.data  ?? []),

    // Contactos nuevos
    newToday:     newToday.count     ?? 0,
    newWeek:      newWeek.count      ?? 0,
    newMonth:     newMonth.count     ?? 0,
    newPrevMonth: newPrevMonth.count ?? 0,

    // Leads
    vipTotal:    vipLeads.count    ?? 0,
    activoTotal: activeLeads.count ?? 0,
    frioTotal:   coldLeads.count   ?? 0,

    // Finanzas
    comprobantesPending:   comprobantesPending.count ?? 0,
    montoVerifHoy:         sumMonto(montoHoyRes.data  ?? []),
    montoVerifMes:         sumMonto(montoMesRes.data  ?? []),
    montoVerifMesAnterior: sumMonto(montoPrevRes.data ?? []),
  });
}
