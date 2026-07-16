// Clasificación de "pendiente" compartida por el contador (API), la lista de
// conversaciones y el dashboard, para que los tres coincidan SIEMPRE.
//
// Reglas de negocio (derivadas; el único estado persistido nuevo es human_taken):
//  · "No leída" mientras last_read_at < último mensaje. SOLO un humano que abre
//    el chat (bump de last_read_at) la marca como leída → limpia el pendiente.
//  · Si el último mensaje es de un operador humano (role 'human') → NO pendiente
//    (ya está siendo atendida).
//  · 🔴 ROJO = no leída, el último mensaje NO es automático del sistema, y (a) un
//    humano YA la agarró (human_taken), o (b) es un cliente ya reconocido
//    (conversation_state 'known_client'). Si la última palabra fue un mensaje
//    automático (bot/offline, role 'assistant'), es 🟠 naranja, no rojo.
//  · Sin color mientras el bot hace onboarding activo (conversation_state ∈
//    BOT_FLOW_STATES): el bot está trabajando, todavía no hay nada para un humano.
//  · 🟠 NARANJA = no leída y ninguno de los anteriores: el bot terminó el
//    onboarding (o es un entrante sin flujo de bot) y espera que un humano la tome.
//    Se mantiene naranja aunque lleguen más mensajes; solo escala a rojo cuando un
//    humano la abre (human_taken pasa a true). Naranja y rojo son excluyentes.

import { BOT_FLOW_STATES } from '@/lib/meta/bot-decision';

export type PendingLevel = 'orange' | 'red' | null;

export function classifyPending(opts: {
  lastRole: string | null | undefined;          // role del mensaje más reciente
  lastMsgAt: string | null | undefined;          // created_at del mensaje más reciente
  lastReadAt: string | null | undefined;
  conversationState: string | null | undefined;
  humanTaken: boolean | null | undefined;        // un humano ya abrió/agarró la conversación
}): PendingLevel {
  const { lastRole, lastMsgAt, lastReadAt, conversationState, humanTaken } = opts;
  if (!lastMsgAt) return null;

  const unread = !lastReadAt || new Date(lastReadAt) < new Date(lastMsgAt);
  if (!unread) return null;

  // El operador humano fue el último en hablar → la conversación ya está atendida.
  if (lastRole === 'human') return null;

  // NOTA (2026-07-16): un evento de sistema (role 'system', p.ej. el chip
  // "✅ Apretó: …" de un click de botón de campaña) SÍ marca pendiente a propósito:
  // el click abre la ventana de 24hs de WhatsApp y el operador necesita ver que hay
  // que responder a tiempo. Antes lo suprimíamos para no inflar la bandeja en envíos
  // masivos; se revirtió porque ver los leads enganchados pesa más. Cae en 🟠 naranja
  // por el flujo de abajo (a menos que known_client/human_taken → 🔴 rojo).

  // Un mensaje automático del sistema (bot u offline, role 'assistant') como
  // ÚLTIMA palabra NO es rojo: todavía no lo atendió ningún humano. Queda 🟠
  // naranja aunque sea un cliente conocido (known_client) o tenga human_taken
  // de antes — el rojo se reserva para cuando el cliente escribió y hay un
  // humano realmente involucrado. Excepción: onboarding activo del bot
  // (BOT_FLOW_STATES), que sigue SIN color más abajo.
  if (lastRole === 'assistant' && !BOT_FLOW_STATES.has(conversationState ?? '')) {
    return 'orange';
  }

  // 🔴 ROJO: (a) ya la agarró un humano, o (b) cliente ya reconocido.
  if (humanTaken) return 'red';
  if (conversationState === 'known_client') return 'red';

  // Sin color: el bot está haciendo onboarding activo con un contacto nuevo.
  if (BOT_FLOW_STATES.has(conversationState ?? '')) return null;

  // 🟠 NARANJA: el bot terminó (o es un entrante sin flujo de bot) → espera un humano.
  return 'orange';
}
