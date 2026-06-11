// Catálogo cerrado de métricas para los widgets personalizados del dashboard.
// SIN imports de servidor: lo usan tanto el endpoint de cálculo como los
// componentes cliente (menú de "Crear widget" + render). El cálculo real
// (queries a Supabase) vive en /api/dashboard_metric, no acá.

export type MetricType = 'count' | 'money' | 'percent';

export type MetricDef = {
  id: string;
  label: string;
  type: MetricType;
  // Métricas "de estado actual" (clientes activos, pendientes, etc.) no tienen
  // período: son una foto del momento. Las de período aceptan los 4 rangos.
  supportsPeriod: boolean;
};

export type PeriodId = 'hoy' | 'semana' | 'mes' | 'mes_anterior';

export const PERIODS: { id: PeriodId; label: string }[] = [
  { id: 'hoy',          label: 'Hoy' },
  { id: 'semana',       label: 'Esta semana' },
  { id: 'mes',          label: 'Este mes' },
  { id: 'mes_anterior', label: 'Mes anterior' },
];

export const METRIC_CATALOG: MetricDef[] = [
  // Con período
  { id: 'conversaciones',         label: 'Conversaciones',          type: 'count', supportsPeriod: true },
  { id: 'contactos_nuevos',       label: 'Contactos nuevos',        type: 'count', supportsPeriod: true },
  { id: 'recargas',               label: 'Recargas (verificadas)',  type: 'count', supportsPeriod: true },
  { id: 'monto_verificado',       label: 'Monto verificado',        type: 'money', supportsPeriod: true },
  { id: 'comprobantes_recibidos', label: 'Comprobantes recibidos',  type: 'count', supportsPeriod: true },
  { id: 'mensajes',               label: 'Mensajes',                type: 'count', supportsPeriod: true },
  // Estado actual (sin período)
  { id: 'clientes_activos',       label: 'Clientes activos',        type: 'count',   supportsPeriod: false },
  { id: 'clientes_inactivos',     label: 'Clientes inactivos',      type: 'count',   supportsPeriod: false },
  { id: 'contactos_nuevos_status',label: 'Contactos en estado nuevo', type: 'count', supportsPeriod: false },
  { id: 'comprobantes_pendientes',label: 'Comprobantes pendientes', type: 'count',   supportsPeriod: false },
  { id: 'total_contactos',        label: 'Total de contactos',      type: 'count',   supportsPeriod: false },
  { id: 'tasa_conversion',        label: 'Tasa de conversión',      type: 'percent', supportsPeriod: false },
];

const METRIC_BY_ID = new Map(METRIC_CATALOG.map((m) => [m.id, m]));
const PERIOD_IDS = new Set<string>(PERIODS.map((p) => p.id));

export function getMetric(id: string): MetricDef | undefined {
  return METRIC_BY_ID.get(id);
}

export function isValidPeriod(p: unknown): p is PeriodId {
  return typeof p === 'string' && PERIOD_IDS.has(p);
}

// Clave estable para mapear el valor de un par (métrica, período).
export function metricKey(metric: string, period: PeriodId | null): string {
  return `${metric}:${period ?? 'none'}`;
}

// Formateo consistente con el resto del dashboard (es-AR).
export function formatMetricValue(type: MetricType, n: number): string {
  if (type === 'money')   return `$${n.toLocaleString('es-AR', { maximumFractionDigits: 0 })}`;
  if (type === 'percent') return `${n.toLocaleString('es-AR', { maximumFractionDigits: 1 })}%`;
  return n.toLocaleString('es-AR');
}
