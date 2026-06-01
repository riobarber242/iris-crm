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

  const weekStart = new Date(todayStart);
  weekStart.setDate(todayStart.getDate() - ((todayStart.getDay() + 6) % 7));

  const monthStart     = new Date(now.getFullYear(), now.getMonth(),     1);
  const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevMonthEnd   = new Date(now.getFullYear(), now.getMonth(),     1);

  // ── Phase 1: all independent metrics + op contact IDs ─────────────────────
  const [
    convTodayRes, convWeekRes, convMonthRes, convPrevMonthRes,
    newToday, newWeek, newMonth, newPrevMonth,
    vipLeads, activeLeads, coldLeads,
    comprobantesPending,
    montoHoyRes, montoMesRes, montoPrevRes,
    totalEnProcesoRes, totalDoneRes,
    opContactsRes,
  ] = await Promise.all([
    supabaseAdmin.from('messages').select('contact_id').gte('created_at', todayStart.toISOString()),
    supabaseAdmin.from('messages').select('contact_id').gte('created_at', weekStart.toISOString()),
    supabaseAdmin.from('messages').select('contact_id').gte('created_at', monthStart.toISOString()),
    supabaseAdmin.from('messages').select('contact_id')
      .gte('created_at', prevMonthStart.toISOString())
      .lt('created_at',  prevMonthEnd.toISOString()),

    supabaseAdmin.from('contacts').select('id', { count: 'exact', head: true }).gte('created_at', todayStart.toISOString()),
    supabaseAdmin.from('contacts').select('id', { count: 'exact', head: true }).gte('created_at', weekStart.toISOString()),
    supabaseAdmin.from('contacts').select('id', { count: 'exact', head: true }).gte('created_at', monthStart.toISOString()),
    supabaseAdmin.from('contacts').select('id', { count: 'exact', head: true })
      .gte('created_at', prevMonthStart.toISOString())
      .lt('created_at',  prevMonthEnd.toISOString()),

    supabaseAdmin.from('leads').select('id', { count: 'exact', head: true }).eq('score', 'vip'),
    supabaseAdmin.from('leads').select('id', { count: 'exact', head: true }).eq('score', 'activo'),
    supabaseAdmin.from('leads').select('id', { count: 'exact', head: true }).eq('score', 'frio'),

    supabaseAdmin.from('comprobantes').select('id', { count: 'exact', head: true }).eq('estado', 'pendiente'),

    supabaseAdmin.from('comprobantes').select('monto').eq('estado', 'verificado').gte('created_at', todayStart.toISOString()),
    supabaseAdmin.from('comprobantes').select('monto').eq('estado', 'verificado').gte('created_at', monthStart.toISOString()),
    supabaseAdmin.from('comprobantes').select('monto').eq('estado', 'verificado')
      .gte('created_at', prevMonthStart.toISOString())
      .lt('created_at',  prevMonthEnd.toISOString()),

    // Pendientes manual — counts
    supabaseAdmin.from('contacts').select('id', { count: 'exact', head: true }).eq('conversation_state', 'en_proceso'),
    supabaseAdmin.from('contacts').select('id', { count: 'exact', head: true }).eq('conversation_state', 'done'),

    // IDs of contacts being handled by operators (needed for phase 2)
    supabaseAdmin.from('contacts').select('id').in('conversation_state', ['done', 'en_proceso']),
  ]);

  // ── Phase 2: metrics that depend on op contact IDs ─────────────────────────
  const opIds = (opContactsRes.data ?? []).map((c: any) => c.id as string);

  let sinResponder = 0;
  let activosHoy   = 0;

  if (opIds.length > 0) {
    const [latestMsgsRes, activosHoyRes] = await Promise.all([
      // Latest messages for op contacts — to detect who spoke last
      supabaseAdmin
        .from('messages')
        .select('contact_id, role')
        .in('contact_id', opIds)
        .order('created_at', { ascending: false }),

      // Any message today for op contacts
      supabaseAdmin
        .from('messages')
        .select('contact_id')
        .in('contact_id', opIds)
        .gte('created_at', todayStart.toISOString()),
    ]);

    // sinResponder: contacts where the latest message role is 'user'
    // (meaning the user spoke last and no operator/bot replied)
    const firstSeenRole = new Map<string, string>();
    for (const msg of (latestMsgsRes.data ?? [])) {
      if (!firstSeenRole.has(msg.contact_id)) {
        firstSeenRole.set(msg.contact_id, msg.role);
      }
    }
    for (const role of firstSeenRole.values()) {
      if (role === 'user') sinResponder++;
    }

    // activosHoy: unique op contacts with at least one message today
    activosHoy = new Set((activosHoyRes.data ?? []).map((m: any) => m.contact_id as string)).size;
  }

  return NextResponse.json({
    convToday:     countUnique(convTodayRes.data    ?? []),
    convWeek:      countUnique(convWeekRes.data     ?? []),
    convMonth:     countUnique(convMonthRes.data    ?? []),
    convPrevMonth: countUnique(convPrevMonthRes.data ?? []),

    newToday:     newToday.count     ?? 0,
    newWeek:      newWeek.count      ?? 0,
    newMonth:     newMonth.count     ?? 0,
    newPrevMonth: newPrevMonth.count ?? 0,

    vipTotal:    vipLeads.count    ?? 0,
    activoTotal: activeLeads.count ?? 0,
    frioTotal:   coldLeads.count   ?? 0,

    comprobantesPending:   comprobantesPending.count ?? 0,
    montoVerifHoy:         sumMonto(montoHoyRes.data  ?? []),
    montoVerifMes:         sumMonto(montoMesRes.data  ?? []),
    montoVerifMesAnterior: sumMonto(montoPrevRes.data ?? []),

    sinResponder,
    activosHoy,
    totalEnProceso: totalEnProcesoRes.count ?? 0,
    totalDone:      totalDoneRes.count      ?? 0,
  });
}
