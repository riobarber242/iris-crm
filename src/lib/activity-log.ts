import { supabaseAdmin } from './db';
import type { SessionPayload } from './session';

// ─────────────────────────────────────────────────────────────────────────────
// Registro de actividad (audit log). Se llama "al costado" de cada acción real.
// Regla de oro: NUNCA hace fallar la acción principal. Si la tabla no existe o
// el insert falla, se traga el error y sigue. La etapa siguiente (IA) consulta
// sobre activity_log filtrando por actor / action / período, siempre por tenant.
// ─────────────────────────────────────────────────────────────────────────────

// Tipos de acción registrados. Mantener estable: la IA consulta sobre estos.
export const ACTIVITY = {
  COMPROBANTE_VERIFICADO: 'comprobante_verificado',
  COMPROBANTE_RECHAZADO:  'comprobante_rechazado',
  MESSAGE_SENT:           'message_sent',          // respondió una conversación
  CONVERSATION_ATTENDED:  'conversation_attended', // atendió (abrió chat con mensajes sin leer)
  SESSION_LOGIN:          'session_login',
  SESSION_LOGOUT:         'session_logout',        // details.reason: 'manual' | 'inactividad'
  CONTACT_EDITED:         'contact_edited',
  CONTACT_IMPORTED:       'contact_imported',
  CONFIG_CHANGED:         'config_changed',         // details.key: system_prompt | bot_enabled | offline_mode | …
} as const;

export type ActivityAction = typeof ACTIVITY[keyof typeof ACTIVITY];

type Actor = { id?: string | null; name?: string | null; role?: string | null };

export type LogActivityParams = {
  // Forma habitual: pasar la sesión y de ahí salen actor + tenant.
  session?: SessionPayload | null;
  // Alternativa para casos sin sesión todavía armada (ej: login).
  tenantId?: string | null;
  actor?: Actor;
  action: ActivityAction | string;
  objectType?: string | null;
  objectId?: string | null;
  details?: Record<string, any> | null;
};

/**
 * Registra una acción en activity_log. NUNCA lanza: cualquier error (tabla
 * inexistente, fallo de red, etc.) se traga con un warning para no trabar la
 * operación real. Sin tenant resuelto, no registra (multi-tenant estricto).
 */
export async function logActivity(params: LogActivityParams): Promise<void> {
  try {
    const tenant_id = params.tenantId ?? params.session?.tenant_id ?? null;
    if (!tenant_id) return;

    const { error } = await supabaseAdmin.from('activity_log').insert({
      tenant_id,
      actor_id:    params.actor?.id   ?? params.session?.sub  ?? null,
      actor_name:  params.actor?.name ?? params.session?.name ?? null,
      actor_role:  params.actor?.role ?? params.session?.role ?? null,
      action:      params.action,
      object_type: params.objectType ?? null,
      object_id:   params.objectId ?? null,
      details:     params.details ?? null,
    });
    // Un error devuelto (no lanzado), p.ej. la tabla aún no existe, se ignora.
    if (error) console.warn('[activity-log] insert devolvió error (se ignora):', error.message);
  } catch (err: any) {
    console.warn('[activity-log] no se pudo registrar:', err?.message ?? err);
  }
}
