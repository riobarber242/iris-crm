/**
 * Test determinístico de la decisión del bot (sin DB ni envíos).
 * Uso: node scripts/test-bot-decision.ts
 */
import { decideBotResponse, type BotDecision } from '../src/lib/meta/bot-decision.ts';

let pass = 0, fail = 0;
function check(name: string, got: BotDecision, expectedAction: BotDecision['action'], expectedReason?: string) {
  const okAction = got.action === expectedAction;
  const okReason = expectedReason === undefined || (got as any).reason === expectedReason;
  const ok = okAction && okReason;
  if (ok) { pass++; console.log(`  ✓ ${name} → ${JSON.stringify(got)}`); }
  else    { fail++; console.log(`  ✗ ${name} → ${JSON.stringify(got)}  (esperado: ${expectedAction}${expectedReason ? '/' + expectedReason : ''})`); }
}

console.log('\n=== Test decisión del bot ===\n');

const base = { botEnabled: true, blocked: false };

console.log('CASO 1 — Número COMPLETAMENTE NUEVO, en horario (hay operadores):');
check('nuevo + en horario', decideBotResponse({ ...base, isNew: true, conversationState: null, operatorAvailable: true }), 'flow');

console.log('\nCASO 2 — Número COMPLETAMENTE NUEVO, fuera de horario (sin operadores):');
check('nuevo + fuera de horario', decideBotResponse({ ...base, isNew: true, conversationState: null, operatorAvailable: false }), 'out_of_hours');

console.log('\nCASO 3 — Contacto EXISTENTE (preexistente en contacts):');
check('existente + en horario',     decideBotResponse({ ...base, isNew: false, conversationState: null, operatorAvailable: true }),  'silent', 'preexisting');
check('existente + fuera de hora',  decideBotResponse({ ...base, isNew: false, conversationState: null, operatorAvailable: false }), 'silent', 'preexisting');
check('existente cliente_activo',   decideBotResponse({ ...base, isNew: false, conversationState: 'done', operatorAvailable: true }), 'silent', 'preexisting');

console.log('\nCASOS EXTRA — onboarding en curso / toggles:');
check('onboarding en curso + en hora',   decideBotResponse({ ...base, isNew: false, conversationState: 'asked_intention', operatorAvailable: true }),  'flow');
check('onboarding en curso + fuera hora', decideBotResponse({ ...base, isNew: false, conversationState: 'asked_intention', operatorAvailable: false }), 'silent', 'out_of_hours_onboarding');
check('bot apagado',                      decideBotResponse({ ...base, botEnabled: false, isNew: true, conversationState: null, operatorAvailable: true }), 'silent', 'bot_disabled');
check('bloqueado',                        decideBotResponse({ ...base, blocked: true, isNew: true, conversationState: null, operatorAvailable: true }),    'silent', 'blocked');

console.log(`\nResultado: ${pass} OK, ${fail} fallidos.\n`);
process.exit(fail === 0 ? 0 : 1);
