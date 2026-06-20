// Clasificación de "pendiente" compartida por el contador (API), la lista de
// conversaciones y el dashboard, para que los tres coincidan SIEMPRE.
//
// Reglas de negocio (sin estado persistido en la base; todo derivado):
//  · "No leída" mientras last_read_at < último mensaje. SOLO un humano que abre
//    el chat (bump de last_read_at) la marca como leída → limpia el pendiente.
//  · 🔴 ROJO    = no leída + CRM ONLINE (no offline) + conversation_state ∈
//                 {'done','known_client'} → terminó el onboarding, o es un cliente
//                 ya reconocido (tiene casino_username) → atención humana directa.
//  · 🟠 NARANJA = no leída + el último mensaje NO es de un humano: lo mandó el
//                 cliente (role 'user') o un robot (role 'assistant': bot Groq o
//                 aviso de offline). Es decir, cualquier entrante sin leer cuenta,
//                 sin importar el estado del contacto ni si el bot respondió.
//  · Si el último mensaje es de un operador humano (role 'human') → NO pendiente
//                 (ya está siendo atendida).
//  · La respuesta de un robot NUNCA limpia el pendiente. ROJO > NARANJA.

export type PendingLevel = 'orange' | 'red' | null;

export function classifyPending(opts: {
  lastRole: string | null | undefined;          // role del mensaje más reciente
  lastMsgAt: string | null | undefined;          // created_at del mensaje más reciente
  lastReadAt: string | null | undefined;
  conversationState: string | null | undefined;
  offline: boolean;
}): PendingLevel {
  const { lastRole, lastMsgAt, lastReadAt, conversationState, offline } = opts;
  if (!lastMsgAt) return null;

  const unread = !lastReadAt || new Date(lastReadAt) < new Date(lastMsgAt);
  if (!unread) return null;

  // El operador humano fue el último en hablar → la conversación ya está atendida.
  if (lastRole === 'human') return null;

  // 🔴 ROJO: onboarding terminado o cliente ya reconocido, estando online.
  if (!offline && (conversationState === 'done' || conversationState === 'known_client')) return 'red';

  // 🟠 NARANJA: cualquier entrante sin leer pendiente de un humano — sea el
  // mensaje crudo del cliente ('user') o una respuesta del bot ('assistant').
  if (lastRole === 'assistant' || lastRole === 'user') return 'orange';

  return null;
}
