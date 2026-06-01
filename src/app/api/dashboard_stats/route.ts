import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';

function countUnique(data: { contact_id: string }[]): number {
  return new Set(data.map((r) => r.contact_id)).size;
}

function sumMonto(data: { monto: number | null }[]): number {
  return data.reduce((s, r) => s + Number(r.monto ?? 0), 0);
}

// Argentina is always UTC-3 (no DST since 2009).
// All period boundaries are expressed in UTC but aligned to Argentina midnight.
// Midnight Argentina = 03:00 UTC.
const ART_OFFSET_MS = 3 * 60 * 60 * 1000;

function buildDates() {
  const utcNow = new Date();

  // Current moment in Argentina local time (as a UTC-anchored Date)
  const argNow     = new Date(utcNow.getTime() - ART_OFFSET_MS);
  const argYear    = argNow.getUTCFullYear();
  const argMonth   = argNow.getUTCMonth(); // 0-indexed
  const argDay     = argNow.getUTCDate();
  const argWeekDay = argNow.getUTCDay();   // 0=Sun … 6=Sat

  // Today: midnight Argentina → 03:00 UTC on the same calendar day
  const todayStart = new Date(Date.UTC(argYear, argMonth, argDay, 3, 0, 0, 0));

  // This week: Monday of the current Argentina week
  const daysToMonday = (argWeekDay + 6) % 7; // 0 on Mon, 6 on Sun
  const weekStart = new Date(Date.UTC(argYear, argMonth, argDay - daysToMonday, 3, 0, 0, 0));

  // This month: 1st of current Argentina month at midnight
  const monthStart = new Date(Date.UTC(argYear, argMonth, 1, 3, 0, 0, 0));

  // Previous month: 1st of previous month → exclusive end = monthStart
  const prevMonthStart = new Date(Date.UTC(argYear, argMonth - 1, 1, 3, 0, 0, 0));
  const prevMonthEnd   = monthStart; // exclusive

  console.log('[dashboard_stats] Date ranges (UTC):',
    `today=${todayStart.toISOString()}`,
    `week=${weekStart.toISOString()}`,
    `month=${monthStart.toISOString()}`,
    `prevMonth=[${prevMonthStart.toISOString()}, ${prevMonthEnd.toISOString()})`,
  );

  return { todayStart, weekStart, monthStart, prevMonthStart, prevMonthEnd };
}

export async function GET() {
  const { todayStart, weekStart, monthStart, prevMonthStart, prevMonthEnd } = buildDates();

  // ── Phase 1: all independent metrics + op contact IDs ─────────────────────
  const [
    convTodayRes, convWeekRes, convMonthRes, convPrevMonthRes,
    newToday, newWeek, newMonth, newPrevMonth,
    vipLeads, activeLeads, coldLeads, scheduledContacts,
    comprobantesPending,
    montoHoyRes, montoMesRes, montoPrevRes,
    totalEnProcesoRes, totalDoneRes,
    opContactsRes,
  ] = await Promise.all([
    // Conversaciones — unique contact_ids with any message in period
    supabaseAdmin.from('messages').select('contact_id').gte('created_at', todayStart.toISOString()),
    supabaseAdmin.from('messages').select('contact_id').gte('created_at', weekStart.toISOString()),
    supabaseAdmin.from('messages').select('contact_id').gte('created_at', monthStart.toISOString()),
    supabaseAdmin.from('messages').select('contact_id')
      .gte('created_at', prevMonthStart.toISOString())
      .lt('created_at',  prevMonthEnd.toISOString()),

    // Contactos nuevos — contacts created in period
    supabaseAdmin.from('contacts').select('id', { count: 'exact', head: true }).gte('created_at', todayStart.toISOString()),
    supabaseAdmin.from('contacts').select('id', { count: 'exact', head: true }).gte('created_at', weekStart.toISOString()),
    supabaseAdmin.from('contacts').select('id', { count: 'exact', head: true }).gte('created_at', monthStart.toISOString()),
    supabaseAdmin.from('contacts').select('id', { count: 'exact', head: true })
      .gte('created_at', prevMonthStart.toISOString())
      .lt('created_at',  prevMonthEnd.toISOString()),

    // Leads
    supabaseAdmin.from('leads').select('id', { count: 'exact', head: true }).eq('score', 'vip'),
    supabaseAdmin.from('leads').select('id', { count: 'exact', head: true }).eq('score', 'activo'),
    supabaseAdmin.from('leads').select('id', { count: 'exact', head: true }).eq('score', 'frio'),
    // Agendados: contacts with casino_username assigned by operator
    supabaseAdmin.from('contacts').select('id', { count: 'exact', head: true })
      .not('casino_username', 'is', null).neq('casino_username', ''),

    // Comprobantes pendientes
    supabaseAdmin.from('comprobantes').select('id', { count: 'exact', head: true }).eq('estado', 'pendiente'),

    // Montos verificados
    supabaseAdmin.from('comprobantes').select('monto').eq('estado', 'verificado').gte('created_at', todayStart.toISOString()),
    supabaseAdmin.from('comprobantes').select('monto').eq('estado', 'verificado').gte('created_at', monthStart.toISOString()),
    supabaseAdmin.from('comprobantes').select('monto').eq('estado', 'verificado')
      .gte('created_at', prevMonthStart.toISOString())
      .lt('created_at',  prevMonthEnd.toISOString()),

    // Pendientes manual
    supabaseAdmin.from('contacts').select('id', { count: 'exact', head: true })
      .or('conversation_state.eq.en_proceso,status.eq.en_proceso'),
    supabaseAdmin.from('contacts').select('id', { count: 'exact', head: true })
      .or('conversation_state.eq.done,status.eq.en_proceso'),

    // IDs for phase 2
    supabaseAdmin.from('contacts').select('id')
      .or('conversation_state.eq.done,conversation_state.eq.en_proceso,status.eq.en_proceso'),
  ]);

  // ── Phase 2: per-contact metrics for op contacts ────────────────────────────
  const opIds = (opContactsRes.data ?? []).map((c: any) => c.id as string);

  let sinResponder = 0;
  let activosHoy   = 0;

  if (opIds.length > 0) {
    const [latestMsgsRes, activosHoyRes] = await Promise.all([
      supabaseAdmin.from('messages').select('contact_id, role')
        .in('contact_id', opIds).order('created_at', { ascending: false }),
      supabaseAdmin.from('messages').select('contact_id')
        .in('contact_id', opIds).gte('created_at', todayStart.toISOString()),
    ]);

    const firstSeenRole = new Map<string, string>();
    for (const msg of (latestMsgsRes.data ?? [])) {
      if (!firstSeenRole.has(msg.contact_id)) firstSeenRole.set(msg.contact_id, msg.role);
    }
    for (const role of firstSeenRole.values()) {
      if (role === 'user') sinResponder++;
    }

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

    vipTotal:       vipLeads.count        ?? 0,
    activoTotal:    activeLeads.count     ?? 0,
    frioTotal:      coldLeads.count       ?? 0,
    scheduledTotal: scheduledContacts.count ?? 0,

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
