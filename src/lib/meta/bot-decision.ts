// ─── Decisión del bot (pura, testeable) ─────────────────────────────────────────
// Decide qué hace el bot ante un mensaje entrante, sin efectos secundarios.
// La lógica de horario (hasActiveOperator) y los envíos viven en handler.ts;
// acá solo se decide en base a valores ya resueltos.

// Estados de onboarding que pertenecen al bot. Si un contacto está en uno de
// estos, el bot inició la conversación y la continúa. Cualquier otro estado
// (null en un contacto preexistente, 'done', 'en_proceso') NO es del bot.
export const BOT_FLOW_STATES = new Set([
  'greeting', 'asked_intention', 'waiting_screenshot', 'asked_if_loader', 'asked_name',
]);

export type BotDecision =
  | { action: 'silent';       reason: string } // no responder nada
  | { action: 'out_of_hours' }                  // enviar aviso de fuera de horario
  | { action: 'flow' };                         // seguir con onboarding / state machine

export function decideBotResponse(opts: {
  botEnabled: boolean;
  blocked: boolean;
  isNew: boolean;
  conversationState: string | null;
  operatorAvailable: boolean;
}): BotDecision {
  const { botEnabled, blocked, isNew, conversationState, operatorAvailable } = opts;

  // Kill switch global y bloqueados → silencio.
  if (!botEnabled) return { action: 'silent', reason: 'bot_disabled' };
  if (blocked)     return { action: 'silent', reason: 'blocked' };

  // REGLA PRINCIPAL: el bot solo atiende números nuevos/desconocidos.
  // Bot-owned = recién creado (isNew) o ya en un onboarding que el bot inició.
  // Cualquier contacto preexistente → cola del operador en silencio, SIN importar
  // status ni horario.
  const inBotFlow = BOT_FLOW_STATES.has(conversationState ?? '');
  if (!isNew && !inBotFlow) return { action: 'silent', reason: 'preexisting' };

  // FUERA DE HORARIO: solo un número COMPLETAMENTE NUEVO recibe el aviso (una vez).
  // Un onboarding en curso espera en silencio. Nunca se onboardea fuera de horario.
  if (!operatorAvailable) {
    return isNew ? { action: 'out_of_hours' } : { action: 'silent', reason: 'out_of_hours_onboarding' };
  }

  // Hay operadores y es un contacto que atiende el bot → seguir el flujo.
  return { action: 'flow' };
}
