import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { getSessionAgent } from '@/lib/current-agent';
import { planForTenant } from '@/lib/plan-guard';
import { hasFeature } from '@/lib/plan';

const MONTHS_ES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

export async function GET() {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });
  const tid = session.tenant_id;

  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5);
  sixMonthsAgo.setDate(1);
  sixMonthsAgo.setHours(0, 0, 0, 0);

  // Sin Caja en el plan no hay comprobantes: ni se consultan (dos queries menos)
  // y los gráficos que dependen de ellos vuelven vacíos con cajaEnabled=false,
  // que es lo que el cliente usa para no dibujar esos paneles.
  const cajaEnabled = hasFeature(await planForTenant(tid), 'caja');

  // Torta de campañas: partición de los mensajes enviados ESTE MES. Ojo con la
  // trampa — "entregados" incluye a los leídos, así que como porciones sueltas
  // sumarían más que el total. Las 4 porciones de abajo son disjuntas y cierran
  // exacto: leídos + entregados-sin-leer + fallidos + en-camino = enviados.
  const mesInicio = new Date();
  mesInicio.setDate(1); mesInicio.setHours(0, 0, 0, 0);
  const mesIso = mesInicio.toISOString();
  const cms = () => supabaseAdmin
    .from('campaign_message_status').select('id', { count: 'exact', head: true })
    .eq('tenant_id', tid).gte('created_at', mesIso);

  // Contactos, comprobantes y recargas se agregan en la base (GROUP BY): antes
  // se traían las filas y se contaban acá, cortadas en 1.000 por PostgREST (Derki
  // tiene 20.214 contactos; Casino, miles de comprobantes). Ver
  // supabase-agregados-sin-tope-rpcs.sql.
  const [contactsRes, comprobantesRes, recargasRes,
         campTotalRes, campLeidosRes, campEntregadosRes, campFallidosRes] = await Promise.all([
    supabaseAdmin.rpc('fn_contacts_breakdown', { p_tenant_id: tid }),
    cajaEnabled
      ? supabaseAdmin.rpc('fn_comprobantes_por_estado', { p_tenant_id: tid })
      : Promise.resolve({ data: [] as any[] }),
    cajaEnabled
      ? supabaseAdmin.rpc('fn_recargas_por_mes', { p_tenant_id: tid, p_since: sixMonthsAgo.toISOString() })
      : Promise.resolve({ data: [] as any[] }),

    // Campañas del mes: total, leídos, entregados (incluye leídos) y fallidos.
    cms(),
    cms().not('read_at', 'is', null),
    cms().not('delivered_at', 'is', null),
    cms().eq('status', 'failed'),
  ]);

  // Grupos (status, provincia, n) de la RPC.
  const contactGroups = ((contactsRes.data ?? []) as { status: string | null; provincia: string | null; n: number }[]);

  // Contact status breakdown
  const statusCount: Record<string, number> = {};
  for (const g of contactGroups) {
    const s = g.status ?? 'nuevo';
    statusCount[s] = (statusCount[s] ?? 0) + Number(g.n);
  }
  const contactsByStatus = [
    { status: 'cliente_activo', label: 'Cliente activo', count: statusCount['cliente_activo'] ?? 0, color: '#C8FF00' },
    { status: 'nuevo',          label: 'Nuevo',          count: statusCount['nuevo']          ?? 0, color: '#4A90D9' },
    { status: 'inactivo',       label: 'Inactivo',       count: statusCount['inactivo']       ?? 0, color: '#aaa'    },
    { status: 'bloqueado',      label: 'Bloqueado',      count: statusCount['bloqueado']      ?? 0, color: '#FF4444' },
    { status: 'en_proceso',     label: 'En proceso',     count: statusCount['en_proceso']     ?? 0, color: '#FFB800' },
  ].filter((s) => s.count > 0);

  // Comprobantes breakdown
  const estadoCount: Record<string, number> = {};
  for (const g of (comprobantesRes.data ?? []) as { estado: string | null; n: number }[]) {
    const e = g.estado ?? 'pendiente';
    estadoCount[e] = (estadoCount[e] ?? 0) + Number(g.n);
  }
  const comprobantesByEstado = [
    { estado: 'verificado', label: 'Verificado', count: estadoCount['verificado'] ?? 0, color: '#22C55E' },
    { estado: 'pendiente',  label: 'Pendiente',  count: estadoCount['pendiente']  ?? 0, color: '#F59E0B' },
    { estado: 'rechazado',  label: 'Rechazado',  count: estadoCount['rechazado']  ?? 0, color: '#EF4444' },
  ].filter((s) => s.count > 0);

  // Revenue by month (last 6)
  const byMonth: Record<string, number> = {};
  // La RPC agrupa por año/mes en UTC (mes 1–12), que es la zona del server: la
  // misma clave que armaba antes getFullYear()/getMonth() sobre cada fila.
  for (const r of (recargasRes.data ?? []) as { anio: number; mes: number; monto: number | string }[]) {
    const key = `${r.anio}-${Number(r.mes) - 1}`;
    byMonth[key] = (byMonth[key] ?? 0) + Number(r.monto ?? 0);
  }
  const now = new Date();
  const revenueByMonth = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - (5 - i), 1);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    return { label: MONTHS_ES[d.getMonth()], monto: byMonth[key] ?? 0 };
  });

  // Province breakdown
  const provMap: Record<string, Record<string, number>> = {};
  for (const g of contactGroups) {
    if (!g.provincia) continue;
    if (!provMap[g.provincia]) provMap[g.provincia] = {};
    const s = g.status ?? 'nuevo';
    provMap[g.provincia][s] = (provMap[g.provincia][s] ?? 0) + Number(g.n);
  }
  // Dominant by business priority, NOT raw majority: a province with even one
  // cliente_activo paints green so active clients are never masked by 'nuevo' contacts.
  const STATUS_PRIORITY = ['cliente_activo', 'en_proceso', 'nuevo', 'inactivo', 'bloqueado'];
  const provinceData = Object.entries(provMap).map(([provincia, counts]) => {
    const total    = Object.values(counts).reduce((s, n) => s + n, 0);
    const dominant = STATUS_PRIORITY.find((s) => (counts[s] ?? 0) > 0)
                  ?? Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0]
                  ?? 'nuevo';
    return { provincia, total, dominant, counts };
  });

  // ── Torta de campañas (porciones disjuntas, suman los enviados del mes) ─────
  const campTotal      = campTotalRes.count      ?? 0;
  const campLeidos     = campLeidosRes.count     ?? 0;
  const campEntregados = campEntregadosRes.count ?? 0;
  const campFallidos   = campFallidosRes.count   ?? 0;
  const campanasByEstado = [
    { estado: 'leidos',       label: 'Leídos',              count: campLeidos,                            color: '#22C55E' },
    { estado: 'sin_leer',     label: 'Entregados sin leer', count: Math.max(0, campEntregados - campLeidos), color: '#1565c0' },
    { estado: 'fallidos',     label: 'Fallidos',            count: campFallidos,                          color: '#EF4444' },
    // Enviados sin confirmación de entrega ni fallo todavía.
    { estado: 'en_camino',    label: 'En camino',           count: Math.max(0, campTotal - campEntregados - campFallidos), color: '#F59E0B' },
  ].filter((s) => s.count > 0);

  return NextResponse.json({
    contactsByStatus,
    comprobantesByEstado,
    campanasByEstado,
    // Con Caja apagada quedan en 0 (no se consultó nada): se mandan vacíos.
    revenueByMonth: cajaEnabled ? revenueByMonth : [],
    provinceData,
    cajaEnabled,
  });
}
