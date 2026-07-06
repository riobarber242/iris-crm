import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { getSessionAgent } from '@/lib/current-agent';
import { classifyPending } from '@/lib/pending';

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

  return { todayStart, weekStart, monthStart, prevMonthStart, prevMonthEnd };
}

export async function GET() {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });
  const tid = session.tenant_id;

  const { todayStart, weekStart, monthStart, prevMonthStart, prevMonthEnd } = buildDates();

  // Rolling 30-day window for the operator first-response SLA
  const slaWindowStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  // ── Todo en paralelo ──────────────────────────────────────────────────────
  // counts (head:true, baratos) + sumas de montos (comprobantes, chico) + las
  // RPCs que AGREGAN en Postgres (conteos por período, SLA, chats activos,
  // snapshot de pendientes). Antes esto traía la tabla `messages` entera (full
  // scan para el último-msg-por-contacto) y filas sueltas para contar únicos /
  // promediar en Node. Ya no viaja messages: solo números / 1 fila por contacto.
  const [
    newToday, newWeek, newMonth, newPrevMonth,
    clienteActivoRes, inactivoRes, nuevoStatusRes, totalContactsRes,
    comprobantesPendingRes,
    montosRes,
    convCountsRes, slaRes, chatsHoyRes, pendSnapRes,
  ] = await Promise.all([
    // Contactos nuevos — creados en el período
    supabaseAdmin.from('contacts').select('id', { count: 'exact', head: true }).eq('tenant_id', tid).gte('created_at', todayStart.toISOString()),
    supabaseAdmin.from('contacts').select('id', { count: 'exact', head: true }).eq('tenant_id', tid).gte('created_at', weekStart.toISOString()),
    supabaseAdmin.from('contacts').select('id', { count: 'exact', head: true }).eq('tenant_id', tid).gte('created_at', monthStart.toISOString()),
    supabaseAdmin.from('contacts').select('id', { count: 'exact', head: true }).eq('tenant_id', tid)
      .gte('created_at', prevMonthStart.toISOString())
      .lt('created_at',  prevMonthEnd.toISOString()),

    // Contactos por status real
    supabaseAdmin.from('contacts').select('id', { count: 'exact', head: true }).eq('tenant_id', tid).eq('status', 'cliente_activo'),
    supabaseAdmin.from('contacts').select('id', { count: 'exact', head: true }).eq('tenant_id', tid).eq('status', 'inactivo'),
    supabaseAdmin.from('contacts').select('id', { count: 'exact', head: true }).eq('tenant_id', tid).eq('status', 'nuevo'),
    // Total de contactos (denominador de la tasa de conversión)
    supabaseAdmin.from('contacts').select('id', { count: 'exact', head: true }).eq('tenant_id', tid),

    // Comprobantes pendientes
    supabaseAdmin.from('comprobantes').select('id', { count: 'exact', head: true }).eq('tenant_id', tid).eq('estado', 'pendiente'),

    // Montos verificados: conteos + sumas por período agregados en Postgres. Antes
    // se traían las filas para sumar/contar en Node, con el mismo cap-1000 (un mes
    // con >1000 verificados subcontaba recargas y monto). Ver supabase-topclients-montos-rpcs.sql.
    supabaseAdmin.rpc('fn_dashboard_montos', {
      p_tenant_id:   tid,
      p_today_start: todayStart.toISOString(),
      p_month_start: monthStart.toISOString(),
      p_prev_start:  prevMonthStart.toISOString(),
      p_prev_end:    prevMonthEnd.toISOString(),
    }),

    // Conversaciones (contactos únicos con algún mensaje en el período) — 1 pasada agregada
    supabaseAdmin.rpc('fn_dashboard_conv_counts', {
      p_tenant_id:   tid,
      p_today_start: todayStart.toISOString(),
      p_week_start:  weekStart.toISOString(),
      p_month_start: monthStart.toISOString(),
      p_prev_start:  prevMonthStart.toISOString(),
      p_prev_end:    prevMonthEnd.toISOString(),
    }),
    // SLA de 1ra respuesta humana (30 días) — promedio calculado en Postgres
    supabaseAdmin.rpc('fn_dashboard_sla_first_human', { p_tenant_id: tid, p_window_start: slaWindowStart.toISOString() }),
    // Chats activos hoy en gestión manual — join en Postgres (sin el .in(opIds))
    supabaseAdmin.rpc('fn_dashboard_chats_activos_hoy', { p_tenant_id: tid, p_today_start: todayStart.toISOString() }),
    // Snapshot por contacto (contacto + su último mensaje) para clasificar pendientes
    supabaseAdmin.rpc('fn_contacts_pending_snapshot', { p_tenant_id: tid }),
  ]);

  // ── Tasa de conversión: clientes activos / total de contactos ───────────────
  const totalContacts  = totalContactsRes.count ?? 0;
  const clienteActivo  = clienteActivoRes.count ?? 0;
  const conversionRate = totalContacts > 0 ? (clienteActivo / totalContacts) * 100 : 0;

  // ── Conversaciones por período (de la RPC: 1 fila con los 4 conteos) ────────
  const cc = (convCountsRes.data as any)?.[0] ?? { conv_today: 0, conv_week: 0, conv_month: 0, conv_prev_month: 0 };

  // ── SLA (de la RPC): numeric → number|null ──────────────────────────────────
  const avgFirstHumanResponseMin = slaRes.data == null ? null : Number(slaRes.data);

  // ── Recargas (cantidad de comprobantes verificados) — de la RPC ─────────────
  const mv = (montosRes.data as any)?.[0] ?? { recargas_hoy: 0, recargas_mes: 0, monto_mes: 0, recargas_prev: 0, monto_prev: 0 };
  const recargasHoy    = Number(mv.recargas_hoy ?? 0);
  const recargasMes    = Number(mv.recargas_mes ?? 0);
  const montoVerifMes  = Number(mv.monto_mes ?? 0);
  const ticketPromedio = recargasMes > 0 ? montoVerifMes / recargasMes : 0;

  // Mes anterior: cantidad y ticket promedio (solo comprobantes verificados).
  const recargasMesAnterior        = Number(mv.recargas_prev ?? 0);
  const montoVerifMesAnterior      = Number(mv.monto_prev ?? 0);
  const ticketPromedioMesAnterior  = recargasMesAnterior > 0 ? montoVerifMesAnterior / recargasMesAnterior : 0;

  // ── Chats activos hoy (de la RPC) ───────────────────────────────────────────
  const chatsActivosHoy = Number(chatsHoyRes.data ?? 0);

  // ── Pendientes: classifyPending (JS, única fuente de verdad) sobre el snapshot ─
  // 🟠 naranja = bot terminó / entrante sin flujo de bot; 🔴 rojo = ya la agarró
  // un humano (human_taken) o cliente reconocido. Solo la lectura humana limpia.
  let pendingOrange = 0;
  let pendingRed    = 0;
  for (const c of ((pendSnapRes.data as any[]) ?? [])) {
    const level = classifyPending({
      lastRole:          c.last_role,
      lastMsgAt:         c.last_msg_at,
      lastReadAt:        c.last_read_at,
      conversationState: c.conversation_state,
      humanTaken:        c.human_taken,
    });
    if (level === 'red')         pendingRed++;
    else if (level === 'orange') pendingOrange++;
  }
  const sinResponder = pendingOrange + pendingRed;

  return NextResponse.json({
    convToday:     cc.conv_today,
    convWeek:      cc.conv_week,
    convMonth:     cc.conv_month,
    convPrevMonth: cc.conv_prev_month,

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
    comprobantesPending:   comprobantesPendingRes.count ?? 0,
    montoVerifMes,
    montoVerifMesAnterior,
    ticketPromedio,
    recargasMesAnterior,
    ticketPromedioMesAnterior,

    // Hero
    sinResponder,
    pendingOrange,
    pendingRed,
  });
}
