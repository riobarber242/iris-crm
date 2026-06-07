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

export type PushPayload = { title: string; body: string; url?: string };

// Envía a una suscripción concreta. Si la suscripción expiró (404/410) la borra.
async function sendToSubscription(row: { id: string; subscription: any }, payload: PushPayload) {
  try {
    await webpush.sendNotification(row.subscription, JSON.stringify(payload));
    return true;
  } catch (err: any) {
    const status = err?.statusCode;
    if (status === 404 || status === 410) {
      console.log(`[push] Suscripción expirada (${status}) — borrando id=${row.id}`);
      await supabaseAdmin.from('push_subscriptions').delete().eq('id', row.id);
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

// Notifica a TODOS los agentes activos con suscripción. Devuelve cuántos push salieron.
export async function notifyActiveAgents(payload: PushPayload): Promise<number> {
  if (!ensureVapid()) return 0;

  const { data: agents, error: aErr } = await supabaseAdmin
    .from('agents')
    .select('id')
    .eq('active', true);
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
