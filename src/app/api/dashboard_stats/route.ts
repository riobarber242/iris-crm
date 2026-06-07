import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { classifyPending } from '@/lib/pending';

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

  // Rolling 30-day window for the operator first-response SLA
  const slaWindowStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  // ── Phase 1: all independent metrics + op contact IDs ─────────────────────
  const [
    convTodayRes, convWeekRes, convMonthRes, convPrevMonthRes,
    newToday, newWeek, newMonth, newPrevMonth,
    clienteActivoRes, inactivoRes, nuevoStatusRes, totalContactsRes,
    comprobantesPending,
    montoHoyRes, montoMesRes, montoPrevRes,
    opContactsRes, slaMsgsRes,
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

    // Contactos por status real
    supabaseAdmin.from('contacts').select('id', { count: 'exact', head: true }).eq('status', 'cliente_activo'),
    supabaseAdmin.from('contacts').select('id', { count: 'exact', head: true }).eq('status', 'inactivo'),
    supabaseAdmin.from('contacts').select('id', { count: 'exact', head: true }).eq('status', 'nuevo'),
    // Total de contactos (denominador de la tasa de conversión)
    supabaseAdmin.from('contacts').select('id', { count: 'exact', head: true }),

    // Comprobantes pendientes
    supabaseAdmin.from('comprobantes').select('id', { count: 'exact', head: true }).eq('estado', 'pendiente'),

    // Montos verificados (HOY se usa solo para contar recargas; el monto de hoy ya no se muestra)
    supabaseAdmin.from('comprobantes').select('monto').eq('estado', 'verificado').gte('created_at', todayStart.toISOString()),
    supabaseAdmin.from('comprobantes').select('monto').eq('estado', 'verificado').gte('created_at', monthStart.toISOString()),
    supabaseAdmin.from('comprobantes').select('monto').eq('estado', 'verificado')
      .gte('created_at', prevMonthStart.toISOString())
      .lt('created_at',  prevMonthEnd.toISOString()),

    // IDs de contactos en gestión manual (para "Sin responder" y "Chats activos hoy")
    supabaseAdmin.from('contacts').select('id')
      .or('conversation_state.eq.done,conversation_state.eq.en_proceso,status.eq.en_proceso'),

    // Mensajes de los últimos 30 días para el SLA de 1ra respuesta del operador
    supabaseAdmin.from('messages').select('contact_id, role, created_at')
      .gte('created_at', slaWindowStart.toISOString())
      .order('created_at', { ascending: true }),
  ]);

  // ── Tasa de conversión: clientes activos / total de contactos ───────────────
  const totalContacts  = totalContactsRes.count ?? 0;
  const clienteActivo  = clienteActivoRes.count ?? 0;
  const conversionRate = totalContacts > 0 ? (clienteActivo / totalContacts) * 100 : 0;

  // ── SLA: tiempo prom. desde que el contacto escribe hasta que un HUMANO responde ─
  // El bot (role=assistant) NO cuenta como atendido. Promedio sobre los últimos 30 días.
  const msgsByContact = new Map<string, { role: string; ts: number }[]>();
  for (const m of (slaMsgsRes.data ?? [])) {
    const arr = msgsByContact.get(m.contact_id) ?? [];
    arr.push({ role: m.role, ts: new Date(m.created_at).getTime() });
    msgsByContact.set(m.contact_id, arr);
  }
  let slaTotalMs = 0;
  let slaCount   = 0;
  for (const msgs of msgsByContact.values()) {
    let pendingUserTs: number | null = null;
    for (const { role, ts } of msgs) {
      if (role === 'user') {
        if (pendingUserTs === null) pendingUserTs = ts; // arranca el cronómetro
      } else if (role === 'human') {
        if (pendingUserTs !== null) { slaTotalMs += ts - pendingUserTs; slaCount++; pendingUserTs = null; }
      }
      // role === 'assistant' (bot): no frena el cronómetro del SLA humano
    }
  }
  const avgFirstHumanResponseMin = slaCount > 0 ? (slaTotalMs / slaCount) / 60000 : null;

  // ── Recargas (cantidad de comprobantes verificados) ─────────────────────────
  const recargasHoy   = (montoHoyRes.data ?? []).length;
  const recargasMes    = (montoMesRes.data ?? []).length;
  const montoVerifMes  = sumMonto(montoMesRes.data ?? []);
  const ticketPromedio = recargasMes > 0 ? montoVerifMes / recargasMes : 0;

  // ── Phase 2: "Chats activos hoy" sobre contactos en gestión ───────────────────
  const opIds = (opContactsRes.data ?? []).map((c: any) => c.id as string);

  let chatsActivosHoy = 0;
  if (opIds.length > 0) {
    const { data: activosHoy } = await supabaseAdmin.from('messages').select('contact_id')
      .in('contact_id', opIds).gte('created_at', todayStart.toISOString());
    chatsActivosHoy = new Set((activosHoy ?? []).map((m: any) => m.contact_id as string)).size;
  }

  // ── Pendientes (misma regla que el sidebar/lista, ver lib/pending.ts) ─────────
  // Sin filtro de fecha. 🟠 naranja = robot respondió y sin leer;
  // 🔴 rojo = online + onboarding 'done' y sin leer. Solo la lectura humana limpia.
  const [offlineSetRes, pendContactsRes, pendMsgsRes] = await Promise.all([
    supabaseAdmin.from('settings').select('value').eq('key', 'offline_mode').limit(1).maybeSingle(),
    supabaseAdmin.from('contacts').select('id, conversation_state, last_read_at'),
    supabaseAdmin.from('messages').select('contact_id, role, created_at').order('created_at', { ascending: false }),
  ]);
  const offlineMode = offlineSetRes.data?.value === 'true';

  const lastMsgByContact = new Map<string, { role: string; created_at: string }>();
  for (const m of (pendMsgsRes.data ?? [])) {
    if (!lastMsgByContact.has(m.contact_id)) lastMsgByContact.set(m.contact_id, { role: m.role, created_at: m.created_at });
  }

  let pendingOrange = 0;
  let pendingRed    = 0;
  for (const c of (pendContactsRes.data ?? [])) {
    const lm = lastMsgByContact.get(c.id as string);
    const level = classifyPending({
      lastRole:          lm?.role,
      lastMsgAt:         lm?.created_at,
      lastReadAt:        c.last_read_at,
      conversationState: c.conversation_state,
      offline:           offlineMode,
    });
    if (level === 'red')         pendingRed++;
    else if (level === 'orange') pendingOrange++;
  }
  const sinResponder = pendingOrange + pendingRed;

  return NextResponse.json({
    convToday:     countUnique(convTodayRes.data    ?? []),
    convWeek:      countUnique(convWeekRes.data     ?? []),
    convMonth:     countUnique(convMonthRes.data    ?? []),
    convPrevMonth: countUnique(convPrevMonthRes.data ?? []),

    newToday:     newToday.count     ?? 0,
    newWeek:      newWeek.count      ?? 0,
    newMonth:     newMonth.count     ?? 0,
    newPrevMonth: newPrevMonth.count ?? 0,

    // Embudo & conversión
    conversionRate,
    clienteActivoTotal: clienteActivo,
    inactivoTotal:      inactivoRes.count    ?? 0,
    nuevoTotal:         nuevoStatusRes.count ?? 0,

    // Operación & recargas
    avgFirstHumanResponseMin,
    recargasHoy,
    recargasMes,
    chatsActivosHoy,

    // Finanzas
    comprobantesPending:   comprobantesPending.count ?? 0,
    montoVerifMes,
    montoVerifMesAnterior: sumMonto(montoPrevRes.data ?? []),
    ticketPromedio,

    // Hero
    sinResponder,
    pendingOrange,
    pendingRed,
  });
}
