// Configuración de personalización del dashboard (Etapa 1).
// Source of truth de los widgets, sus labels default, su grupo visual y los
// helpers para mergear/sanitizar lo guardado en settings.dashboard_layout.
// Sin imports de servidor: lo usan tanto la API como los componentes cliente.

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

export type WidgetConfig = {
  id: WidgetId;
  label: string;
  visible: boolean;
  order: number;
};

// Zona visual donde se renderiza cada widget. El orden guardado se respeta
// dentro de cada zona (ver DashboardClient).
export type WidgetGroup = 'hero' | 'metric' | 'chart';

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

/**
 * Combina la config guardada con los defaults:
 *  - respeta label/visible/order de lo guardado,
 *  - agrega widgets nuevos (que no existían en una config vieja) al final,
 *  - descarta ids desconocidos,
 *  - siempre devuelve los 10 widgets, ordenados y con `order` normalizado a 0..n.
 */
export function mergeLayout(saved: unknown): WidgetConfig[] {
  if (!Array.isArray(saved)) {
    return DEFAULT_LAYOUT.map((w) => ({ ...w }));
  }

  const byId = new Map<string, Partial<WidgetConfig>>();
  for (const item of saved) {
    if (item && typeof item === 'object' && KNOWN_IDS.has((item as { id?: unknown }).id as string)) {
      byId.set((item as { id: string }).id, item as Partial<WidgetConfig>);
    }
  }

  // Para mandar los widgets nuevos (sin entrada guardada) al final.
  let nextOrder = byId.size;

  const merged: WidgetConfig[] = WIDGET_ORDER.map((id, i) => {
    const s = byId.get(id);
    if (!s) {
      return { id, label: DEFAULT_LABELS[id], visible: true, order: nextOrder++ };
    }
    return {
      id,
      label:   typeof s.label === 'string' && s.label.trim() ? s.label : DEFAULT_LABELS[id],
      visible: typeof s.visible === 'boolean' ? s.visible : true,
      order:   typeof s.order === 'number' ? s.order : i,
    };
  });

  merged.sort((a, b) => a.order - b.order);
  return merged.map((w, i) => ({ ...w, order: i }));
}

/** Sanitiza lo que llega del cliente antes de persistir. Devuelve los 10 widgets. */
export function sanitizeLayout(input: unknown): WidgetConfig[] {
  return mergeLayout(input);
}
