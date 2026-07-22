// Web Push helpers (VAPID). Usado por /api/push/send y por el webhook para
// notificar a los operadores cuando entra un mensaje de cliente.
import webpush from 'web-push';
import { supabaseAdmin } from './db';

let configured = false;

// Configura VAPID una sola vez. Devuelve false si faltan las keys.
function ensureVapid(): boolean {
  if (configured) return true;
  const publicKey  = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) {
    console.warn('[push] VAPID keys no configuradas — push deshabilitado');
    return false;
  }
  const subject = process.env.VAPID_SUBJECT || 'mailto:admin@iris-crm.app';
  webpush.setVapidDetails(subject, publicKey, privateKey);
  configured = true;
  return true;
}

// `kind` lo usa el Service Worker para decidir el sonido de la notificación:
//  - 'conversation' → suena (mensaje de cliente, incl. pantalla bloqueada).
//  - 'comprobante'  → silenciosa (carga/pago a verificar: solo badge, sin ruido).
export type PushPayload = { title: string; body: string; url?: string; kind?: 'conversation' | 'comprobante' };

// Envía a una suscripción concreta. Si la suscripción expiró (404/410) la borra.
async function sendToSubscription(row: { id: string; subscription: any }, payload: PushPayload) {
  try {
    // Urgencia del web push (header Urgency → prioridad FCM en Android):
    //  - conversación → 'high': le pide a FCM que DESPIERTE el dispositivo aunque
    //    esté en Doze (pantalla apagada). Sin esto, urgency='normal' (default) hace
    //    que FCM postergue/agrupe el mensaje hasta que se prende la pantalla → la
    //    notificación aparece al desbloquear pero no suena/vibra en el momento.
    //  - comprobante → default (solo badge, silenciosa por diseño): no la apuramos.
    // OJO: esto ayuda a la ENTREGA a tiempo, pero el sonido/vibración sobre pantalla
    // bloqueada también depende de la importancia del NotificationChannel que crea
    // Chrome/la PWA por sitio (fija al crearse, el código no la puede cambiar) y de
    // la optimización de batería del SO (Samsung suspende apps agresivamente).
    const options = (payload.kind ?? 'conversation') === 'comprobante'
      ? undefined
      : { urgency: 'high' as const };
    await webpush.sendNotification(row.subscription, JSON.stringify(payload), options);
    return true;
  } catch (err: any) {
    const status = err?.statusCode;
    if (status === 404 || status === 410) {
      // Borra SOLO ese dispositivo (por endpoint, su clave única; NUNCA por
      // agent_id, que voltearía todos los dispositivos del operador). Fallback
      // al id de la fila si la suscripción no trajera endpoint.
      const ep = row.subscription?.endpoint;
      console.log(`[push] Suscripción expirada (${status}) — borrando endpoint=${ep ?? `(id ${row.id})`}`);
      if (ep) await supabaseAdmin.from('push_subscriptions').delete().eq('endpoint', ep);
      else    await supabaseAdmin.from('push_subscriptions').delete().eq('id', row.id);
    } else {
      console.warn(`[push] Error enviando push (id=${row.id}):`, err?.message ?? err);
    }
    return false;
  }
}

// Notifica a un agente puntual (su única suscripción).
export async function notifyAgent(agentId: string, payload: PushPayload): Promise<number> {
  if (!ensureVapid()) return 0;
  const { data, error } = await supabaseAdmin
    .from('push_subscriptions')
    .select('id, subscription')
    .eq('agent_id', agentId);
  if (error) { console.warn('[push] Error leyendo push_subscriptions:', error.message); return 0; }

  let sent = 0;
  for (const row of data ?? []) if (await sendToSubscription(row, payload)) sent++;
  return sent;
}

// Notifica según la asignación del chat (multi-operador), SOLO dentro del tenant:
//  - chat con agente asignado → push SOLO a ese agente + a los admins activos del tenant.
//  - chat sin asignar         → push a todos los agentes activos del tenant.
// Devuelve cuántos push salieron.
export async function notifyContactAgents(assignedAgentId: string | null, tenantId: string, payload: PushPayload): Promise<number> {
  if (!ensureVapid()) return 0;

  let targetIds: string[];

  if (assignedAgentId) {
    // Agente asignado + admins activos DEL TENANT (los admins ven todo lo suyo).
    const { data: admins, error } = await supabaseAdmin
      .from('agents')
      .select('id')
      .eq('active', true)
      .eq('role', 'admin')
      .eq('tenant_id', tenantId);
    if (error) console.warn('[push] Error leyendo admins:', error.message);
    targetIds = Array.from(new Set<string>([assignedAgentId, ...(admins ?? []).map((a: { id: string }) => a.id)]));
  } else {
    const { data: agents, error } = await supabaseAdmin
      .from('agents')
      .select('id')
      .eq('active', true)
      .eq('tenant_id', tenantId);
    if (error) { console.warn('[push] Error leyendo agents:', error.message); return 0; }
    targetIds = (agents ?? []).map((a: { id: string }) => a.id);
  }

  if (targetIds.length === 0) return 0;

  const { data: subs, error: sErr } = await supabaseAdmin
    .from('push_subscriptions')
    .select('id, subscription')
    .in('agent_id', targetIds);
  if (sErr) { console.warn('[push] Error leyendo push_subscriptions:', sErr.message); return 0; }

  let sent = 0;
  for (const row of subs ?? []) if (await sendToSubscription(row, payload)) sent++;
  console.log(`[push] notifyContactAgents(assigned=${assignedAgentId ?? 'none'}) → ${sent}/${(subs ?? []).length} push enviados`);
  return sent;
}

// Notifica a los agentes activos DEL TENANT que tienen el módulo de Campañas
// (roles admin y agent — los operadores no lo ven, ver AdminShell). Devuelve
// cuántos push salieron. Dos filtros obligatorios:
//  · tenant_id: sin él, un push de un tenant (p.ej. el nombre de una campaña
//    pausada) llegaba a los operadores de todos los demás tenants.
//  · role: no tiene sentido avisar de una pausa de campaña a quien no tiene el
//    módulo. Whitelist (no "≠ operator"): un rol nuevo no recibe hasta sumarlo.
// Hoy su único uso es el aviso de campaña pausada (send-core).
export async function notifyActiveAgents(tenantId: string, payload: PushPayload): Promise<number> {
  if (!ensureVapid()) return 0;

  const { data: agents, error: aErr } = await supabaseAdmin
    .from('agents')
    .select('id')
    .eq('active', true)
    .eq('tenant_id', tenantId)
    .in('role', ['admin', 'agent']);
  if (aErr) { console.warn('[push] Error leyendo agents:', aErr.message); return 0; }

  const ids = (agents ?? []).map((a: { id: string }) => a.id);
  if (ids.length === 0) return 0;

  const { data: subs, error: sErr } = await supabaseAdmin
    .from('push_subscriptions')
    .select('id, subscription')
    .in('agent_id', ids);
  if (sErr) { console.warn('[push] Error leyendo push_subscriptions:', sErr.message); return 0; }

  let sent = 0;
  for (const row of subs ?? []) if (await sendToSubscription(row, payload)) sent++;
  console.log(`[push] notifyActiveAgents → ${sent}/${(subs ?? []).length} push enviados`);
  return sent;
}
