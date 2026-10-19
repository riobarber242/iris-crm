import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { getSessionAgent } from '@/lib/current-agent';
import { getMetric, isValidPeriod, metricKey, type PeriodId } from '@/lib/dashboard-metrics';
import { planForTenant } from '@/lib/plan-guard';
import { isMetricAllowedFor } from '@/lib/plan';

// Cálculo on-demand de un widget personalizado (métrica × período), validado
// contra el catálogo cerrado de dashboard-metrics. El tenant SIEMPRE sale de la
// sesión (nunca del request) y toda query filtra por él: mismo aislamiento que
// dashboard_stats / dashboard_charts.

// Argentina = UTC-3 fijo (sin DST). Medianoche AR = 03:00 UTC. Mismas fronteras
// de período que /api/dashboard_stats.
const ART_OFFSET_MS = 3 * 60 * 60 * 1000;

function periodBounds() {
  const argNow   = new Date(Date.now() - ART_OFFSET_MS);
  const y = argNow.getUTCFullYear();
  const m = argNow.getUTCMonth();
  const d = argNow.getUTCDate();
  const wd = argNow.getUTCDay(); // 0=Dom … 6=Sáb
  const daysToMonday = (wd + 6) % 7;
  return {
    todayStart:     new Date(Date.UTC(y, m, d, 3, 0, 0, 0)).toISOString(),
    weekStart:      new Date(Date.UTC(y, m, d - daysToMonday, 3, 0, 0, 0)).toISOString(),
    monthStart:     new Date(Date.UTC(y, m, 1, 3, 0, 0, 0)).toISOString(),
    prevMonthStart: new Date(Date.UTC(y, m - 1, 1, 3, 0, 0, 0)).toISOString(),
  };
}

function periodRange(period: PeriodId): { gte: string; lt?: string } {
  const b = periodBounds();
  switch (period) {
    case 'hoy':          return { gte: b.todayStart };
    case 'semana':       return { gte: b.weekStart };
    case 'mes':          return { gte: b.monthStart };
    case 'mes_anterior': return { gte: b.prevMonthStart, lt: b.monthStart };
  }
}

// Aplica el rango de fechas (sobre created_at) a un query builder de Supabase.
function withRange(q: any, range: { gte: string; lt?: string }) {
  q = q.gte('created_at', range.gte);
  if (range.lt) q = q.lt('created_at', range.lt);
  return q;
}

async function computeMetric(tid: string, metric: string, period: PeriodId | null): Promise<number> {
  const def = getMetric(metric);
  if (!def) return 0;
  const range = period ? periodRange(period) : null;

  switch (metric) {
    case 'conversaciones': {
      // Contactos únicos con algún mensaje en el período, contados en la base con
      // la misma RPC que dashboard_stats (antes: filas traídas acá, cortadas en
      // 1.000). Los 4 períodos del catálogo son exactamente los de la RPC.
      if (!period) return 0;
      const b = periodBounds();
      const { data } = await supabaseAdmin.rpc('fn_dashboard_conv_counts', {
        p_tenant_id:   tid,
        p_today_start: b.todayStart,
        p_week_start:  b.weekStart,
        p_month_start: b.monthStart,
        p_prev_start:  b.prevMonthStart,
        p_prev_end:    b.monthStart,
      });
      const cc = (data as any)?.[0];
      if (!cc) return 0;
      const byPeriod: Record<PeriodId, number> = {
        hoy: cc.conv_today, semana: cc.conv_week, mes: cc.conv_month, mes_anterior: cc.conv_prev_month,
      };
      return Number(byPeriod[period] ?? 0);
    }
    case 'mensajes': {
      let q = supabaseAdmin.from('messages').select('id', { count: 'exact', head: true }).eq('tenant_id', tid);
      if (range) q = withRange(q, range);
      const { count } = await q;
      return count ?? 0;
    }
    case 'contactos_nuevos': {
      let q = supabaseAdmin.from('contacts').select('id', { count: 'exact', head: true }).eq('tenant_id', tid);
      if (range) q = withRange(q, range);
      const { count } = await q;
      return count ?? 0;
    }
    case 'recargas': {
      let q = supabaseAdmin.from('comprobantes').select('id', { count: 'exact', head: true }).eq('tenant_id', tid).eq('estado', 'verificado');
      if (range) q = withRange(q, range);
      const { count } = await q;
      return count ?? 0;
    }
    case 'monto_verificado': {
      // Suma en la base (antes: se sumaban acá las primeras 1.000 filas).
      const { data } = await supabaseAdmin.rpc('fn_comprobantes_verificados', {
        p_tenant_id: tid, p_gte: range?.gte ?? null, p_lt: range?.lt ?? null,
      });
      return Number((data as any)?.[0]?.monto ?? 0);
    }
    case 'comprobantes_recibidos': {
      let q = supabaseAdmin.from('comprobantes').select('id', { count: 'exact', head: true }).eq('tenant_id', tid);
      if (range) q = withRange(q, range);
      const { count } = await q;
      return count ?? 0;
    }
    case 'clientes_activos': {
      const { count } = await supabaseAdmin.from('contacts').select('id', { count: 'exact', head: true }).eq('tenant_id', tid).eq('status', 'cliente_activo');
      return count ?? 0;
    }
    case 'clientes_inactivos': {
      const { count } = await supabaseAdmin.from('contacts').select('id', { count: 'exact', head: true }).eq('tenant_id', tid).eq('status', 'inactivo');
      return count ?? 0;
    }
    case 'contactos_nuevos_status': {
      const { count } = await supabaseAdmin.from('contacts').select('id', { count: 'exact', head: true }).eq('tenant_id', tid).eq('status', 'nuevo');
      return count ?? 0;
    }
    case 'comprobantes_pendientes': {
      const { count } = await supabaseAdmin.from('comprobantes').select('id', { count: 'exact', head: true }).eq('tenant_id', tid).eq('estado', 'pendiente');
      return count ?? 0;
    }
    case 'total_contactos': {
      const { count } = await supabaseAdmin.from('contacts').select('id', { count: 'exact', head: true }).eq('tenant_id', tid);
      return count ?? 0;
    }
    case 'tasa_conversion': {
      const [activos, total] = await Promise.all([
        supabaseAdmin.from('contacts').select('id', { count: 'exact', head: true }).eq('tenant_id', tid).eq('status', 'cliente_activo'),
        supabaseAdmin.from('contacts').select('id', { count: 'exact', head: true }).eq('tenant_id', tid),
      ]);
      const t = total.count ?? 0;
      return t > 0 ? ((activos.count ?? 0) / t) * 100 : 0;
    }
    default:
      return 0;
  }
}

export async function POST(request: Request) {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });
  const tid = session.tenant_id;

  let body: any;
  try { body = await request.json(); } catch { body = {}; }
  const rawPairs: any[] = Array.isArray(body?.pairs) ? body.pairs : [];

  // Normalizar + validar contra el catálogo; descartar lo inválido y deduplicar.
  // Las métricas fuera del plan se descartan igual que un id inexistente: no se
  // calculan (son queries a comprobantes que en Lite no tienen sentido) y no
  // vuelven en la respuesta, aunque el layout guardado del tenant las pida.
  const plan = await planForTenant(session.tenant_id);
  const seen = new Set<string>();
  const pairs: { metric: string; period: PeriodId | null; key: string }[] = [];
  for (const p of rawPairs) {
    const metric = typeof p?.metric === 'string' ? p.metric : '';
    const def = getMetric(metric);
    if (!def) continue;
    if (!isMetricAllowedFor(plan, metric)) continue;
    const period: PeriodId | null = def.supportsPeriod && isValidPeriod(p?.period) ? p.period : null;
    if (def.supportsPeriod && !period) continue; // métrica con período pero período inválido
    const key = metricKey(metric, period);
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({ metric, period, key });
  }

  const results = await Promise.all(pairs.map((p) => computeMetric(tid, p.metric, p.period)));
  const values: Record<string, number> = {};
  pairs.forEach((p, i) => { values[p.key] = results[i]; });

  return NextResponse.json({ values });
}
