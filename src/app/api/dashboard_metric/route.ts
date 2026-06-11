import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { getSessionAgent } from '@/lib/current-agent';
import { getMetric, isValidPeriod, metricKey, type PeriodId } from '@/lib/dashboard-metrics';

// Cálculo on-demand de un widget personalizado (métrica × período), validado
// contra el catálogo cerrado de dashboard-metrics. El tenant SIEMPRE sale de la
// sesión (nunca del request) y toda query filtra por él: mismo aislamiento que
// dashboard_stats / dashboard_charts.

// Argentina = UTC-3 fijo (sin DST). Medianoche AR = 03:00 UTC. Mismas fronteras
// de período que /api/dashboard_stats.
const ART_OFFSET_MS = 3 * 60 * 60 * 1000;

function periodRange(period: PeriodId): { gte: string; lt?: string } {
  const argNow   = new Date(Date.now() - ART_OFFSET_MS);
  const y = argNow.getUTCFullYear();
  const m = argNow.getUTCMonth();
  const d = argNow.getUTCDate();
  const wd = argNow.getUTCDay(); // 0=Dom … 6=Sáb

  const todayStart     = new Date(Date.UTC(y, m, d, 3, 0, 0, 0));
  const daysToMonday   = (wd + 6) % 7;
  const weekStart      = new Date(Date.UTC(y, m, d - daysToMonday, 3, 0, 0, 0));
  const monthStart     = new Date(Date.UTC(y, m, 1, 3, 0, 0, 0));
  const prevMonthStart = new Date(Date.UTC(y, m - 1, 1, 3, 0, 0, 0));

  switch (period) {
    case 'hoy':          return { gte: todayStart.toISOString() };
    case 'semana':       return { gte: weekStart.toISOString() };
    case 'mes':          return { gte: monthStart.toISOString() };
    case 'mes_anterior': return { gte: prevMonthStart.toISOString(), lt: monthStart.toISOString() };
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
      // contactos únicos con algún mensaje en el período
      let q = supabaseAdmin.from('messages').select('contact_id').eq('tenant_id', tid);
      if (range) q = withRange(q, range);
      const { data } = await q;
      return new Set((data ?? []).map((r: any) => r.contact_id)).size;
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
      let q = supabaseAdmin.from('comprobantes').select('monto').eq('tenant_id', tid).eq('estado', 'verificado');
      if (range) q = withRange(q, range);
      const { data } = await q;
      return (data ?? []).reduce((s: number, r: any) => s + Number(r.monto ?? 0), 0);
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
  const seen = new Set<string>();
  const pairs: { metric: string; period: PeriodId | null; key: string }[] = [];
  for (const p of rawPairs) {
    const metric = typeof p?.metric === 'string' ? p.metric : '';
    const def = getMetric(metric);
    if (!def) continue;
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
