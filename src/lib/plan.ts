// Catálogo de planes comerciales de IRIS — FUENTE ÚNICA de qué incluye cada plan.
//
// SIN imports de servidor a propósito (igual que lib/dashboard-metrics.ts): lo
// consumen el middleware (Edge), los route handlers (Node), los server components
// y el sidebar del navegador. Si acá entra `@/lib/db` se rompe el middleware.
//
// La idea es que agregar una sección premium sea EDITAR UNA ENTRADA de este
// archivo, no salir a cazar prefijos por middleware + menú + guards. Todo lo
// demás (bloqueo de rutas, filtrado del menú, métricas del dashboard) se deriva
// de acá.

export type Plan = 'trial' | 'lite' | 'premium';

// Orden de presentación en el selector de Membresía del panel de admin.
export const PLANS: Plan[] = ['trial', 'lite', 'premium'];

export const PLAN_LABEL: Record<Plan, string> = {
  trial:   'Trial',
  lite:    'Lite',
  premium: 'Premium',
};

// Etiqueta tolerante para pintar un plan que viene de la base como string suelto
// (incluido un valor viejo tipo 'basic' que se haya colado): si no lo conocemos,
// mostramos el crudo en vez de mentir con otro nombre.
export function planLabel(raw: string | null | undefined): string {
  const p = String(raw ?? '');
  return (PLAN_LABEL as Record<string, string>)[p] ?? p;
}

// ─── Features ────────────────────────────────────────────────────────────────
// Sólo se listan las features RECORTABLES. Lo que no está acá es núcleo y lo
// tienen todos los planes: Conversaciones, Contactos, Campañas, Mi Bot,
// Dashboard (básico) y Configuración.
export type Feature =
  | 'caja'           // Cargas, Pagos, Fichas, Mi Caja y todo lo de comprobantes
  | 'casino'         // integración con el casino (alta de usuario, saldo, depósitos)
  | 'operadores'     // alta y gestión de usuarios operadores
  | 'chat_interno'   // chat entre operadores del cliente
  | 'top_clientes'   // ranking de clientes
  | 'iris_ai'        // asistente interno (widget + transcripción de voz)
  | 'dashboard_full';// métricas y gráficos que dependen de Caja

const ALL_FEATURES: Feature[] = [
  'caja', 'casino', 'operadores', 'chat_interno', 'top_clientes', 'iris_ai', 'dashboard_full',
];

// Qué incluye cada plan. 'trial' = premium completo mientras dura la prueba (es
// como se comporta hoy el tenant Principal, que está en trial y ve todo).
export const PLAN_FEATURES: Record<Plan, Feature[]> = {
  trial:   ALL_FEATURES,
  premium: ALL_FEATURES,
  lite:    [],
};

// Rutas y secciones de cada feature. `sections` son las claves del menú de
// AdminShell; `pages` y `apis` son PREFIJOS (matchean la ruta exacta o cualquier
// subruta), el mismo criterio que usa el middleware para los permisos por rol.
export const FEATURE_ROUTES: Record<Feature, { sections: string[]; pages: string[]; apis: string[] }> = {
  caja: {
    sections: ['cargas', 'pagos', 'fichas', 'mi-caja'],
    pages:    ['/cargas', '/pagos', '/fichas', '/mi-caja'],
    apis:     ['/api/caja', '/api/fichas', '/api/comprobantes'],
  },
  casino: {
    sections: [],
    pages:    [],
    apis:     ['/api/casino'],
  },
  operadores: {
    sections: ['agentes'],
    pages:    ['/agentes'],
    apis:     ['/api/agents'],
  },
  chat_interno: {
    sections: ['chat-interno'],
    pages:    ['/chat-interno'],
    apis:     ['/api/internal'],
  },
  top_clientes: {
    sections: ['top-clientes'],
    pages:    ['/top-clientes'],
    apis:     ['/api/leads'],
  },
  iris_ai: {
    sections: [],
    pages:    [],
    // /api/iris/transcribe es la entrada de voz del mismo asistente.
    apis:     ['/api/iris-ai', '/api/iris'],
  },
  dashboard_full: {
    // El Dashboard NO se bloquea entero en Lite: se recorta por métrica (ver
    // METRICS_BY_PLAN). Por eso esta feature no aporta rutas.
    sections: [],
    pages:    [],
    apis:     [],
  },
};

// ─── Métricas del dashboard por plan ─────────────────────────────────────────
// Ids del catálogo de lib/dashboard-metrics.ts. En Lite quedan las 4 que se
// calculan sólo con contacts + messages.
//
// OJO — por qué NO están clientes_activos / clientes_inactivos /
// contactos_nuevos_status / tasa_conversion, aunque sólo consulten `contacts`:
// el status del contacto se deriva EXCLUSIVAMENTE de comprobantes verificados
// (ver lib/contact-status.ts). Sin Caja ningún contacto sale nunca de 'nuevo',
// así que esas cuatro quedarían clavadas en 0 / 0 / todos / 0% para siempre.
export const LITE_METRICS: string[] = [
  'conversaciones',
  'mensajes',
  'contactos_nuevos',
  'total_contactos',
];

// null = sin recorte (todo el catálogo).
export const METRICS_BY_PLAN: Record<Plan, string[] | null> = {
  trial:   null,
  premium: null,
  lite:    LITE_METRICS,
};

// Widgets FIJOS del dashboard (ids de lib/dashboard-layout.ts) que no tienen
// sentido sin Caja. Los tres primeros son puro comprobante; 'embudo_conversion'
// entra por el mismo motivo que las métricas de status: sin comprobantes
// verificados ningún contacto sale de 'nuevo' y mostraría 0 / 0 / todos / 0%.
//
// 'operacion' NO está acá porque es mixto: su tarjeta de "Tiempo 1ra respuesta"
// sí aplica a Lite. Ese widget se queda y esconde por dentro las 3 tarjetas de
// caja (ver DashboardClient).
export const CAJA_WIDGETS: string[] = [
  'finanzas',
  'comprobantes_chart',
  'mes_anterior_actual',
  'embudo_conversion',
];

// Widgets del dashboard que este plan no debe mostrar.
export function hiddenWidgetsFor(plan: unknown): string[] {
  return hasFeature(plan, 'caja') ? [] : CAJA_WIDGETS;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Normaliza lo que venga de la base o del token de sesión.
//
// ⚠️ Un plan desconocido o ausente cae en 'premium' A PROPÓSITO: las sesiones
// firmadas antes de este cambio no traen `plan` (cookie de 7 días) y los tres
// tenants actuales son premium/trial. Fallar cerrado acá dejaría a clientes que
// ya pagan sin secciones hasta que vuelvan a loguearse. Cuando todas las
// sesiones hayan rotado, esto se puede invertir a 'lite'.
export function normalizePlan(raw: unknown): Plan {
  const p = String(raw ?? '');
  return (PLANS as string[]).includes(p) ? (p as Plan) : 'premium';
}

export function hasFeature(plan: unknown, feature: Feature): boolean {
  return PLAN_FEATURES[normalizePlan(plan)].includes(feature);
}

export function featuresFor(plan: unknown): Feature[] {
  return PLAN_FEATURES[normalizePlan(plan)];
}

// Features que el plan NO tiene: es lo que hay que bloquear/esconder.
export function missingFeaturesFor(plan: unknown): Feature[] {
  const has = new Set(featuresFor(plan));
  return ALL_FEATURES.filter((f) => !has.has(f));
}

// Claves del menú que este plan no debe mostrar.
export function blockedSectionsFor(plan: unknown): string[] {
  return missingFeaturesFor(plan).flatMap((f) => FEATURE_ROUTES[f].sections);
}

// Prefijos de páginas y de API que este plan no debe poder abrir.
export function blockedPathsFor(plan: unknown): { pages: string[]; apis: string[] } {
  const missing = missingFeaturesFor(plan);
  return {
    pages: missing.flatMap((f) => FEATURE_ROUTES[f].pages),
    apis:  missing.flatMap((f) => FEATURE_ROUTES[f].apis),
  };
}

// Match de prefijo: ruta exacta o subruta. Mismo criterio que matchesPrefix() del
// middleware — vive acá para que el gate del plan y el de roles no diverjan.
export function matchesPathPrefix(pathname: string, prefixes: string[]): boolean {
  return prefixes.some((p) => pathname === p || pathname.startsWith(p + '/'));
}

// ¿Esta ruta está fuera del plan? El middleware la usa para responder 404 (que
// la sección se comporte como inexistente, no como "bloqueada").
export function isPathBlockedFor(plan: unknown, pathname: string): boolean {
  const { pages, apis } = blockedPathsFor(plan);
  return matchesPathPrefix(pathname, pages) || matchesPathPrefix(pathname, apis);
}

// Ids de métricas permitidas, o null si no hay recorte.
export function metricsFor(plan: unknown): string[] | null {
  return METRICS_BY_PLAN[normalizePlan(plan)];
}

export function isMetricAllowedFor(plan: unknown, metricId: string): boolean {
  const allowed = metricsFor(plan);
  return allowed === null || allowed.includes(metricId);
}
