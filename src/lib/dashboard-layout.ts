// Configuración de personalización del dashboard (Etapa 1).
// Source of truth de los widgets, sus labels default, su grupo visual y los
// helpers para mergear/sanitizar lo guardado en settings.dashboard_layout.
// Sin imports de servidor: lo usan tanto la API como los componentes cliente.

import { getMetric, isValidPeriod, type PeriodId } from './dashboard-metrics';

export type WidgetId =
  | 'sin_responder'
  | 'conversaciones'
  | 'contactos_nuevos'
  | 'embudo_conversion'
  | 'finanzas'
  | 'operacion'
  | 'estado_contactos'
  | 'comprobantes_chart'
  | 'distribucion_provincia'
  | 'mes_anterior_actual';

// Spec de un widget creado por el agente (métrica del catálogo + período +
// formato). Solo presente en widgets custom; los widgets fijos no lo llevan.
export type CustomWidgetSpec = {
  metric: string;
  period: PeriodId | null;            // null en métricas de estado (sin período)
  format: 'single' | 'breakdown';
};

export type WidgetConfig = {
  id: string;                         // WidgetId fijo, o 'custom_<...>' para custom
  label: string;
  visible: boolean;
  order: number;
  custom?: CustomWidgetSpec;          // presente solo en widgets creados por el agente
};

// Zona visual donde se renderiza cada widget. El orden guardado se respeta
// dentro de cada zona (ver DashboardClient).
export type WidgetGroup = 'hero' | 'metric' | 'chart';

// Prefijo de id de los widgets custom (para distinguirlos de los fijos).
export const CUSTOM_PREFIX = 'custom_';

export function isCustomWidget(w: WidgetConfig): boolean {
  return !!w.custom && typeof w.id === 'string' && w.id.startsWith(CUSTOM_PREFIX);
}

// Grupo visual de cualquier widget: los custom siempre van en la zona 'metric'.
export function widgetGroup(w: WidgetConfig): WidgetGroup {
  if (w.custom) return 'metric';
  return WIDGET_GROUP[w.id as WidgetId] ?? 'metric';
}

export const WIDGET_GROUP: Record<WidgetId, WidgetGroup> = {
  sin_responder:          'hero',
  conversaciones:         'metric',
  contactos_nuevos:       'metric',
  embudo_conversion:      'metric',
  finanzas:               'metric',
  operacion:              'metric',
  estado_contactos:       'chart',
  comprobantes_chart:     'chart',
  distribucion_provincia: 'chart',
  mes_anterior_actual:    'chart',
};

export const DEFAULT_LABELS: Record<WidgetId, string> = {
  sin_responder:          'Sin Responder',
  conversaciones:         'Conversaciones',
  contactos_nuevos:       'Contactos Nuevos',
  embudo_conversion:      'Embudo & Conversión',
  finanzas:               'Finanzas',
  operacion:              'Operación',
  estado_contactos:       'Estado de Contactos',
  comprobantes_chart:     'Comprobantes',
  distribucion_provincia: 'Distribución por Provincia',
  mes_anterior_actual:    'Mes Anterior vs Actual',
};

// Orden canónico de los widgets (orden por defecto).
export const WIDGET_ORDER: WidgetId[] = [
  'sin_responder',
  'conversaciones',
  'contactos_nuevos',
  'embudo_conversion',
  'finanzas',
  'operacion',
  'estado_contactos',
  'comprobantes_chart',
  'distribucion_provincia',
  'mes_anterior_actual',
];

export const DEFAULT_LAYOUT: WidgetConfig[] = WIDGET_ORDER.map((id, i) => ({
  id,
  label: DEFAULT_LABELS[id],
  visible: true,
  order: i,
}));

const KNOWN_IDS = new Set<string>(WIDGET_ORDER);

// Valida + normaliza un widget custom guardado. Devuelve null si no es válido
// (id sin el prefijo, métrica fuera del catálogo, etc.) para descartarlo.
function sanitizeCustomWidget(item: any, fallbackOrder: number): WidgetConfig | null {
  const id = item?.id;
  if (typeof id !== 'string' || !id.startsWith(CUSTOM_PREFIX)) return null;
  const c = item?.custom;
  const def = c && typeof c === 'object' ? getMetric(c.metric) : undefined;
  if (!def) return null;

  let period: PeriodId | null = null;
  let format: 'single' | 'breakdown' = 'single';
  if (def.supportsPeriod) {
    period = isValidPeriod(c.period) ? c.period : 'mes';
    format = c.format === 'breakdown' ? 'breakdown' : 'single';
  }

  const label = typeof item.label === 'string' && item.label.trim()
    ? item.label.trim().slice(0, 60)
    : def.label;

  return {
    id,
    label,
    visible: typeof item.visible === 'boolean' ? item.visible : true,
    order:   typeof item.order === 'number' ? item.order : fallbackOrder,
    custom:  { metric: def.id, period, format },
  };
}

/**
 * Combina la config guardada con los defaults:
 *  - respeta label/visible/order de lo guardado (widgets fijos),
 *  - preserva los widgets custom válidos creados por el agente,
 *  - agrega widgets fijos nuevos (que no existían en una config vieja) al final,
 *  - descarta ids desconocidos / custom inválidos,
 *  - devuelve todo ordenado y con `order` normalizado a 0..n.
 */
export function mergeLayout(saved: unknown): WidgetConfig[] {
  if (!Array.isArray(saved)) {
    return DEFAULT_LAYOUT.map((w) => ({ ...w }));
  }

  const result: WidgetConfig[] = [];
  const seenFixed = new Set<string>();

  for (const item of saved) {
    if (!item || typeof item !== 'object') continue;
    const id = (item as { id?: unknown }).id;
    if (typeof id !== 'string') continue;

    if (KNOWN_IDS.has(id)) {
      if (seenFixed.has(id)) continue; // ignorar duplicados de un id fijo
      seenFixed.add(id);
      const s = item as Partial<WidgetConfig>;
      result.push({
        id,
        label:   typeof s.label === 'string' && s.label.trim() ? s.label : DEFAULT_LABELS[id as WidgetId],
        visible: typeof s.visible === 'boolean' ? s.visible : true,
        order:   typeof s.order === 'number' ? s.order : result.length,
      });
    } else {
      const custom = sanitizeCustomWidget(item, result.length);
      if (custom) result.push(custom);
      // ids desconocidos no-custom → descartados
    }
  }

  // Agregar al final cualquier widget fijo que no estuviera guardado.
  for (const id of WIDGET_ORDER) {
    if (!seenFixed.has(id)) {
      result.push({ id, label: DEFAULT_LABELS[id], visible: true, order: result.length });
    }
  }

  result.sort((a, b) => a.order - b.order);
  return result.map((w, i) => ({ ...w, order: i }));
}

/** Sanitiza lo que llega del cliente antes de persistir. */
export function sanitizeLayout(input: unknown): WidgetConfig[] {
  return mergeLayout(input);
}
