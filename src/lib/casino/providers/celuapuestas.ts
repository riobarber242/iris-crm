// src/lib/casino/providers/celuapuestas.ts
// Adaptador de celuapuestas (plataforma ABP: login de agente + token, vía el proxy).
//
// Es anterior al modelo de proveedores y su camino de operaciones NO se toca en este
// trabajo: crear jugador, depositar y el saldo del agente siguen corriendo por el
// código propio de los routes con lib/casino/client.ts (legacyOperations). Este
// adaptador aporta solo lo que el modelo genérico necesita para cualquier tenant:
//   · los campos, mapeados a las columnas propias de casino_accounts (la fila de
//     17Star queda idéntica, sin migrar datos);
//   · la prueba de conexión, que envuelve testCasinoConnection sin cambiarlo.

import { doDeposit, getPlayerInfo, testCasinoConnection, type CasinoTestFailReason, type DoDepositResult } from '../client';
import type { CasinoCreds } from '../account';
import type {
  CasinoProvider, ProviderBalanceResult, ProviderContext, ProviderFailReason, ProviderTestResult, ProviderWriteResult,
} from './types';

// Mismos textos que /api/casino/test-connection: solo bad_credentials habla de la
// contraseña (un falso "contraseña incorrecta" hace que la pisen, 20/08/2026).
const TEST_MSG: Record<CasinoTestFailReason, string> = {
  bad_credentials:    'Usuario o contraseña incorrectos',
  agent_not_found:    'Conectó pero no encontramos ese ID de agente',
  forbidden_target:   'Ese casino todavía no está habilitado, avisá a soporte',
  casino_unavailable: 'No se pudo conectar con el casino, puede estar caído temporalmente. Reintentá en unos minutos.',
  timeout:            'El casino no respondió a tiempo, puede estar caído temporalmente. Reintentá en unos minutos.',
  proxy_secret:       'Problema de configuración de IRIS con el casino, avisá a soporte',
  unknown:            'No se pudo conectar con el casino, puede estar caído temporalmente. Reintentá en unos minutos.',
};

const TEST_REASON: Record<CasinoTestFailReason, ProviderFailReason> = {
  bad_credentials:    'bad_credentials',
  agent_not_found:    'invalid',
  forbidden_target:   'forbidden',
  casino_unavailable: 'unavailable',
  timeout:            'timeout',
  proxy_secret:       'unavailable',
  unknown:            'unavailable',
};

// Host del panel a partir de la URL (acepta host pelado o URL completa). Misma regla
// que deriveHost de /api/casino/account.
function hostOf(apiBaseUrl: string): string | null {
  const s = (apiBaseUrl ?? '').trim();
  if (!s) return null;
  try { return new URL(s).host; }
  catch { return s.replace(/^https?:\/\//, '').replace(/\/.*$/, '') || null; }
}

async function testConnection(ctx: ProviderContext): Promise<ProviderTestResult> {
  const skinDomain = ctx.values.skin_domain || hostOf(ctx.values.api_base_url ?? '') || '';
  const r = await testCasinoConnection({
    accountId:     ctx.accountId || undefined,
    agentUsername: ctx.values.agent_username ?? '',
    agentId:       ctx.values.agent_id ?? '',
    agentPassword: ctx.secrets.agent_password ?? '',
    skinId:        ctx.values.skin_id ?? '',
    skinDomain,
    tenantId:      ctx.tenantId,
  });
  if (r.ok) {
    return { ok: true, message: `Conectado — agente ${r.agentName}, saldo ${r.balance.toLocaleString('es-AR')}` };
  }
  return { ok: false, reason: TEST_REASON[r.reason], error: TEST_MSG[r.reason] };
}


// ── Operaciones para la protección de doble depósito (casino_deposit_guard) ───
// Con el interruptor por tenant `casino_deposit_guard` = 'true', verificar una carga
// de celuapuestas pasa por lib/casino/verify-carga + deposit-guard (reserva atómica,
// saldo antes, depósito clasificado, reconciliación) en vez de creditPlayer. Estas
// dos funciones son lo que el guard necesita. Envuelven client.ts SIN cambiarlo:
// getPlayerInfo (agregada al final de client.ts) y doDeposit tal cual.
// Con el interruptor apagado no se llaman nunca.

function credsOf(ctx: ProviderContext): CasinoCreds {
  return {
    accountId:     ctx.accountId || undefined,
    agentUsername: ctx.values.agent_username ?? '',
    agentId:       ctx.values.agent_id ?? '',
    agentPassword: ctx.secrets.agent_password ?? '',
    skinId:        ctx.values.skin_id ?? '',
    skinDomain:    ctx.values.skin_domain || hostOf(ctx.values.api_base_url ?? '') || '',
    tenantId:      ctx.tenantId,
  };
}

// accountId (targetId) del jugador que trajo la lectura de saldo previa, para que el
// depósito no repita el GetAgentWithChildren. Corto y por instancia.
const TARGET_TTL_MS = 60_000;
const targetCache = new Map<string, { targetId: string; at: number }>();
const targetKey = (ctx: ProviderContext, username: string) => `${ctx.accountId}:${username}`;

async function playerBalance(
  ctx: ProviderContext,
  username: string,
  opts: { deadlineAt?: number; timeoutMs?: number; retry?: boolean } = {},
): Promise<ProviderBalanceResult> {
  const r = await getPlayerInfo(credsOf(ctx), username, {
    deadlineAt: opts.deadlineAt,
    timeoutMs: opts.timeoutMs,
    retryDelaysMs: opts.retry === false ? [] : undefined,
  });
  if (r.ok) {
    targetCache.set(targetKey(ctx, username), { targetId: r.targetId, at: Date.now() });
    return { ok: true, balance: r.balance };
  }
  if (r.reason === 'not_found') {
    return { ok: false, reason: 'not_found', error: `Player no encontrado en el casino: ${username}.` };
  }
  return { ok: false, reason: 'unavailable', error: 'El casino no está respondiendo.', detail: r.detail };
}

/**
 * Clasifica el resultado de doDeposit para el guard:
 *   · 201                                   → ok
 *   · el pedido no salió / el jugador no se encontró → not_applied
 *   · respuesta JSON de error del casino (ABP envuelve la excepción y revierte la
 *     operación) o 401/403 sin JSON (lo cortó el proxy antes del casino) → not_applied
 *   · excepción (timeout, red) o cualquier otra respuesta sin JSON (5xx, 502 del
 *     proxy, HTML) → ambiguous: el casino pudo haberlo procesado.
 */
async function deposit(ctx: ProviderContext, username: string, amount: number, deadlineAt: number): Promise<ProviderWriteResult> {
  const creds = credsOf(ctx);
  const cached = targetCache.get(targetKey(ctx, username));
  let targetId = cached && Date.now() - cached.at < TARGET_TTL_MS ? cached.targetId : '';
  if (!targetId) {
    const info = await getPlayerInfo(creds, username, { deadlineAt });
    if (!info.ok) {
      return info.reason === 'not_found'
        ? { kind: 'not_applied', reason: 'not_found', error: `Player no encontrado en el casino: ${username}.` }
        : { kind: 'not_applied', reason: 'unavailable', error: 'El casino no está respondiendo.', detail: info.detail };
    }
    targetId = info.targetId;
  }

  let res: DoDepositResult;
  try {
    res = await doDeposit(creds, { username, targetId, amount }, deadlineAt);
  } catch (err) {
    return classifyDeposit({ thrown: err });
  }
  return classifyDeposit({ result: res });
}

/** Clasificación pura del resultado de doDeposit (exportada para la prueba offline). */
export function classifyDeposit(input: { result?: DoDepositResult; thrown?: unknown }): ProviderWriteResult {
  if (input.thrown !== undefined) {
    const err = input.thrown as { name?: unknown; message?: unknown } | null;
    const text = `${String(err?.name ?? '')} ${String(err?.message ?? err ?? '')}`;
    const timedOut = /abort|timeout/i.test(text);
    return {
      kind: 'ambiguous', reason: timedOut ? 'timeout' : 'unavailable',
      error: timedOut ? 'El casino no respondió a tiempo al depositar.' : 'Se cortó la comunicación con el casino al depositar.',
      detail: text.trim().slice(0, 200),
    };
  }
  const res = input.result;
  if (res?.success) return { kind: 'ok' };

  const detail = String(res?.detail ?? res?.error ?? '');
  const sinJson = /respuesta no JSON/i.test(detail);
  if (sinJson && !/HTTP 40[13]\b/.test(detail)) {
    return { kind: 'ambiguous', reason: 'unavailable', error: 'El casino respondió algo inesperado al depositar.', detail };
  }
  return { kind: 'not_applied', reason: 'rejected', error: `El casino rechazó el depósito: ${detail || 'sin motivo'}.`, detail };
}

export const celuapuestasProvider: CasinoProvider = {
  id: 'celuapuestas',
  label: 'celuapuestas (ABP)',
  fields: [
    { key: 'agent_username', label: 'Usuario del agente', kind: 'text', required: true, column: 'agent_username' },
    {
      key: 'agent_password', label: 'Contraseña / token del agente', kind: 'secret', required: true,
      column: 'agent_password_enc', help: 'Se guarda cifrada. Vacía = no se cambia la guardada.',
    },
    {
      key: 'agent_id', label: 'ID de agente', kind: 'text', required: true, column: 'agent_id',
      help: 'Identificador interno del agente; se usa para acreditar las fichas.',
    },
    {
      key: 'skin_id', label: 'Skin ID', kind: 'text', required: true, column: 'skin_id',
      help: 'Identificador del skin; lo exige la creación de usuarios.',
    },
    {
      key: 'api_base_url', label: 'Dominio del casino (panel / API)', kind: 'url', required: true,
      column: 'api_base_url', placeholder: 'https://admin.tucasino.com',
      help: 'Tiene que estar habilitado en el proxy de IRIS.',
    },
  ],
  deriveColumns: (values) => ({ skin_domain: hostOf(values.api_base_url ?? '') }),
  legacyOperations: true,
  hasAgentBalance: true,
  password: {
    rule: /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/,
    ruleText: 'La contraseña debe tener al menos 8 caracteres, una mayúscula, una minúscula y un número.',
    generate: () => `Suerte${Math.floor(1000 + Math.random() * 9000)}`,
  },
  testConnection,
  // Solo con casino_deposit_guard prendido (ver arriba). legacyOperations sigue en
  // true: con el interruptor apagado todo sigue por el código de siempre.
  playerBalance,
  deposit,
};
