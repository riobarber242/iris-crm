// src/lib/casino/providers/agentesplus.ts
// Adaptador de agentes.plus. API de su documentación oficial:
//   POST <api_url>  (default https://agentes.plus/api.php)
//   Headers: Content-Type: application/json · X-API-Key: <secret key del agente>
//   Acciones: create_player {username,password} · deposit {username,amount} ·
//             withdraw {username,amount} · player_balance {username}
//   OK  → HTTP 200 y {"status":1,"data":{...}}.  Falla → {"status":0,"error":"motivo"}.
//   HTTP: 400 datos inválidos · 401 key ausente/inválida · 403 sin permiso sobre el
//   jugador · 404 jugador no encontrado · 429 límite (60 consultas por minuto).
//
// withdraw no se usa (los retiros no están integrados) y la acción no documentada de
// RTP no se implementa a propósito.
//
// La API no da un ID de operación, así que un deposit no es idempotente. Este módulo
// se limita a decir con precisión qué pasó ('ok' / 'not_applied' / 'ambiguous'); la
// reserva atómica y la reconciliación por saldo viven en ../deposit-guard.ts.
//
// Llamada directa, sin el proxy de celuapuestas: probado el 30/09/2026 que agentes.plus
// contesta desde Argentina y desde un datacenter de afuera (401 JSON sin key, detrás
// de Cloudflare, sin geo-bloqueo). Si algún día hiciera falta un desvío, api_url es un
// campo por tenant.
//
// La secret key NUNCA se loguea: los logs llevan acción, jugador, HTTP y el motivo del
// proveedor (recortado y con la key tachada por si el proveedor la repitiera).

import type {
  CasinoProvider,
  ProviderBalanceResult,
  ProviderContext,
  ProviderCreateResult,
  ProviderFailReason,
  ProviderTestResult,
  ProviderWriteResult,
} from './types';

export const AGENTESPLUS_DEFAULT_URL = 'https://agentes.plus/api.php';

const REQUEST_TIMEOUT_MS = 10_000;
// Presupuesto por defecto de una llamada suelta (routes sin maxDuration: default 15s).
const DEFAULT_BUDGET_MS = 12_000;
// El alta es LENTA del lado de agentes.plus: el 30/09/2026 el primer create_player
// no respondió en los 12s del presupuesto por defecto (el timeout de 15s que pedía
// nunca aplicaba: ganaba el presupuesto). Tiene su propio techo; los routes que la
// llaman declaran maxDuration = 60 y le reservan tiempo a la confirmación posterior.
const CREATE_TIMEOUT_MS = 40_000;
const CREATE_BUDGET_MS = 42_000;
// Escalera ante 429. Si el proveedor manda Retry-After, manda él (con techo).
const RATE_LIMIT_DELAYS_MS = [2_000, 5_000, 10_000];
const MAX_RETRY_AFTER_MS = 10_000;
// Solo para lecturas (player_balance): hipos de 5xx / HTML.
const READ_RETRY_DELAYS_MS = [1_000, 3_000];
const MIN_ATTEMPT_MS = 1_500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const remainingMs = (deadlineAt: number) => Math.max(0, deadlineAt - Date.now());

type Action = 'create_player' | 'deposit' | 'player_balance';

interface RawResult {
  /** 0 = no hubo respuesta HTTP (timeout / red). */
  httpStatus: number;
  json: any | null;
  timedOut: boolean;
  networkError: boolean;
  /** No se llegó a enviar el pedido (sin presupuesto): seguro que no se aplicó. */
  notSent?: boolean;
  /** Duración del último intento, en ms (para el diagnóstico en los logs). */
  ms?: number;
  attempts: number;
  retryAfterMs: number | null;
  /** Motivo del proveedor ("error"), recortado y sin la key. */
  providerError: string;
}

function sanitize(text: unknown, apiKey: string): string {
  let s = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (apiKey && apiKey.length >= 6) s = s.split(apiKey).join('***');
  return s;
}

function apiUrl(ctx: ProviderContext): string {
  const u = (ctx.values.api_url ?? '').trim();
  return u || AGENTESPLUS_DEFAULT_URL;
}

function isOk(r: RawResult): boolean {
  return r.httpStatus === 200 && r.json != null && Number(r.json.status) === 1;
}

async function once(ctx: ProviderContext, payload: Record<string, unknown>, timeoutMs: number): Promise<RawResult> {
  const apiKey = ctx.secrets.api_key ?? '';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(apiUrl(ctx), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
      body: JSON.stringify(payload),
      signal: controller.signal,
      cache: 'no-store',
    });
    const text = await res.text().catch(() => '');
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* HTML / vacío → json null */ }
    const ra = Number(res.headers.get('retry-after'));
    return {
      httpStatus: res.status,
      json,
      timedOut: false,
      networkError: false,
      attempts: 1,
      retryAfterMs: Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, MAX_RETRY_AFTER_MS) : null,
      providerError: json ? sanitize(json.error ?? json.message, apiKey) : sanitize(text.slice(0, 120), apiKey),
    };
  } catch (err: any) {
    const timedOut = err?.name === 'AbortError';
    return {
      httpStatus: 0, json: null, timedOut, networkError: !timedOut, attempts: 1, retryAfterMs: null,
      providerError: timedOut ? 'sin respuesta a tiempo' : sanitize(err?.message ?? 'error de red', apiKey),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Llama a la API con la política de reintentos:
 *   · 429 → siempre se reintenta (el proveedor NO procesó el pedido), con espera.
 *   · 5xx / respuesta sin JSON / error de red → solo si `retryUnavailable` (lecturas).
 *   · timeout → nunca (ya se comió el timeout entero, y en una escritura es ambiguo).
 */
async function call(
  ctx: ProviderContext,
  action: Action,
  payload: Record<string, unknown>,
  opts: { deadlineAt?: number; timeoutMs?: number; retryUnavailable: boolean; retryRateLimit?: boolean },
): Promise<RawResult> {
  const deadlineAt = opts.deadlineAt ?? Date.now() + DEFAULT_BUDGET_MS;
  const retryRateLimit = opts.retryRateLimit ?? true;
  let rlTry = 0;
  let unavailableTry = 0;
  let attempts = 0;
  let last: RawResult | null = null;

  for (;;) {
    const budget = remainingMs(deadlineAt);
    if (budget < MIN_ATTEMPT_MS) {
      if (last) return { ...last, attempts };
      // Nunca salió: no es un timeout (eso sería ambiguo en una escritura).
      return {
        httpStatus: 0, json: null, timedOut: false, networkError: false, notSent: true, attempts: 0, retryAfterMs: null,
        providerError: 'sin tiempo para llamar a agentes.plus',
      };
    }
    attempts++;
    const timeoutMs = Math.min(opts.timeoutMs ?? REQUEST_TIMEOUT_MS, budget);
    const t0 = Date.now();
    last = await once(ctx, { action, ...payload }, timeoutMs);
    last.ms = Date.now() - t0;
    const username = typeof payload.username === 'string' ? payload.username : '-';
    const tag = `[agentesplus] ${action} tenant=${ctx.tenantId} jugador=${username} intento=${attempts}`;

    if (isOk(last)) {
      console.log(`${tag} OK http=200 ms=${last.ms}`);
      return { ...last, attempts };
    }

    let delay: number | undefined;
    if (last.httpStatus === 429 && retryRateLimit) {
      delay = last.retryAfterMs ?? RATE_LIMIT_DELAYS_MS[rlTry];
      rlTry++;
      if (rlTry > RATE_LIMIT_DELAYS_MS.length) delay = undefined;
    } else if (
      opts.retryUnavailable && !last.timedOut &&
      (last.networkError || last.httpStatus >= 500 || (last.httpStatus === 200 && last.json == null))
    ) {
      delay = READ_RETRY_DELAYS_MS[unavailableTry++];
    }

    console.warn(
      `${tag} FALLÓ http=${last.httpStatus || '-'}${last.timedOut ? ` timeout(${timeoutMs}ms)` : ''}` +
      `${last.networkError ? ' red' : ''} ms=${last.ms} motivo="${last.providerError}"` +
      (delay !== undefined ? ` — reintento en ${delay}ms` : ''),
    );

    if (delay === undefined) return { ...last, attempts };
    if (remainingMs(deadlineAt) < delay + MIN_ATTEMPT_MS) {
      console.warn(`${tag} sin presupuesto para reintentar — corto acá`);
      return { ...last, attempts };
    }
    await sleep(delay);
  }
}

// ── Traducción a motivos y mensajes para el operador ─────────────────────────

function reasonOf(r: RawResult): ProviderFailReason {
  if (r.timedOut) return 'timeout';
  switch (r.httpStatus) {
    case 400: return 'invalid';
    case 401: return 'bad_credentials';
    case 403: return 'forbidden';
    case 404: return 'not_found';
    case 429: return 'rate_limited';
  }
  if (r.httpStatus === 200 && r.json != null && 'status' in r.json) return 'rejected';
  return 'unavailable';
}

function withReason(base: string, r: RawResult): string {
  return r.providerError ? `${base} Motivo de agentes.plus: "${r.providerError}".` : base;
}

function messageOf(reason: ProviderFailReason, r: RawResult, username?: string): string {
  const who = username ? ` ${username}` : '';
  switch (reason) {
    case 'bad_credentials': return 'La API key de agentes.plus es inválida o falta. Avisá al soporte de IRIS.';
    case 'forbidden':       return withReason(`El jugador${who} no pertenece a este agente en agentes.plus.`, r);
    case 'not_found':       return `El jugador${who} no existe en agentes.plus.`;
    case 'invalid':         return withReason('agentes.plus rechazó los datos.', r);
    case 'rejected':        return withReason('agentes.plus rechazó la operación.', r);
    case 'rate_limited':    return 'agentes.plus está limitando las consultas (máximo 60 por minuto). Esperá un minuto y reintentá.';
    case 'timeout':         return 'agentes.plus no respondió a tiempo.';
    default:                return withReason('agentes.plus no respondió bien.', r);
  }
}

function detailOf(r: RawResult): string {
  return `http=${r.httpStatus || '-'} intentos=${r.attempts}${r.timedOut ? ' timeout' : ''}` +
    `${r.networkError ? ' red' : ''}${r.notSent ? ' no-enviado' : ''} ms=${r.ms ?? '-'} motivo="${r.providerError}"`;
}

/**
 * ¿Hay certeza de que una ESCRITURA no se aplicó? Cuando el pedido no llegó a salir,
 * o cuando el proveedor contestó y dijo que no: cualquier 4xx (incluye un bloqueo de
 * Cloudflare antes del servidor) o un 200 con status 0. Timeout, error de red, 5xx o
 * un 200 sin JSON son ambiguos.
 */
function definitelyNotApplied(r: RawResult): boolean {
  if (r.notSent) return true;
  if (r.httpStatus >= 400 && r.httpStatus < 500) return true;
  return r.httpStatus === 200 && r.json != null && 'status' in r.json && Number(r.json.status) !== 1;
}

// ── Operaciones ──────────────────────────────────────────────────────────────

async function playerBalance(
  ctx: ProviderContext,
  username: string,
  opts: { deadlineAt?: number; timeoutMs?: number; retry?: boolean } = {},
): Promise<ProviderBalanceResult> {
  const r = await call(ctx, 'player_balance', { username }, {
    deadlineAt: opts.deadlineAt, timeoutMs: opts.timeoutMs,
    retryUnavailable: opts.retry ?? true, retryRateLimit: opts.retry ?? true,
  });
  if (isOk(r)) {
    const balance = Number(r.json?.data?.balance);
    if (Number.isFinite(balance)) return { ok: true, balance };
    return { ok: false, reason: 'unavailable', error: 'agentes.plus devolvió un saldo ilegible.', detail: detailOf(r) };
  }
  const reason = reasonOf(r);
  return { ok: false, reason, error: messageOf(reason, r, username), detail: detailOf(r) };
}

async function createPlayer(
  ctx: ProviderContext, username: string, password: string, opts: { deadlineAt?: number } = {},
): Promise<ProviderCreateResult> {
  // Crear no es idempotente: solo se reintenta un 429 (no procesado). Presupuesto
  // propio (el alta tarda): el caller puede acotarlo para reservar tiempo a la
  // confirmación por saldo.
  const r = await call(ctx, 'create_player', { username, password }, {
    retryUnavailable: false,
    timeoutMs: CREATE_TIMEOUT_MS,
    deadlineAt: opts.deadlineAt ?? Date.now() + CREATE_BUDGET_MS,
  });
  if (isOk(r)) return { ok: true };
  const reason = reasonOf(r);
  const ambiguous = !definitelyNotApplied(r);
  // El texto exacto de "usuario ya existe" no está documentado: heurística amplia
  // sobre el motivo, solo cuando el proveedor rechazó de verdad.
  const taken = !ambiguous && /exist|registrad|en uso|ocupad|duplicad|taken|already/i.test(r.providerError);
  return { ok: false, reason, error: messageOf(reason, r, username), taken, ambiguous, detail: detailOf(r) };
}

async function deposit(ctx: ProviderContext, username: string, amount: number, deadlineAt: number): Promise<ProviderWriteResult> {
  // Mueve plata: único reintento posible es el 429, que el proveedor rechazó sin
  // procesar. Ni 5xx ni timeout ni error de red se reintentan.
  const r = await call(ctx, 'deposit', { username, amount }, { deadlineAt, retryUnavailable: false });
  if (isOk(r)) return { kind: 'ok' };
  const reason = reasonOf(r);
  const error = messageOf(reason, r, username);
  return definitelyNotApplied(r)
    ? { kind: 'not_applied', reason, error, detail: detailOf(r) }
    : { kind: 'ambiguous', reason, error, detail: detailOf(r) };
}

async function testConnection(ctx: ProviderContext): Promise<ProviderTestResult> {
  if (!ctx.secrets.api_key) return { ok: false, reason: 'bad_credentials', error: 'Falta cargar la API key.' };
  // Sin efectos: consulta el saldo de un jugador que no existe. Con la key buena el
  // proveedor contesta 404 (jugador no encontrado); con la key mala, 401.
  const probe = `irisprobe${Math.floor(Math.random() * 1e9)}`;
  const r = await call(ctx, 'player_balance', { username: probe }, { retryUnavailable: true });
  if (isOk(r) || r.httpStatus === 404) {
    return { ok: true, message: 'Conectado con agentes.plus: la API key es válida.' };
  }
  const reason = reasonOf(r);
  return { ok: false, reason, error: messageOf(reason, r) };
}

// Mismo criterio que el alta de celuapuestas (≥8, mayúscula, minúscula y dígito):
// agentes.plus no documenta reglas, así que se usa la más estricta conocida.
const PASSWORD_RE = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/;

export const agentesplusProvider: CasinoProvider = {
  id: 'agentesplus',
  label: 'agentes.plus',
  fields: [
    {
      key: 'api_key', label: 'Secret key del agente', kind: 'secret', required: true,
      help: 'La secret key que genera el panel de agentes.plus. Se guarda cifrada y no se vuelve a mostrar.',
    },
    {
      key: 'api_url', label: 'URL de la API', kind: 'url', required: false,
      defaultValue: AGENTESPLUS_DEFAULT_URL, placeholder: AGENTESPLUS_DEFAULT_URL,
      help: 'Dejala vacía para usar la oficial.',
    },
  ],
  hasAgentBalance: false,
  password: {
    rule: PASSWORD_RE,
    ruleText: 'La contraseña debe tener al menos 8 caracteres, una mayúscula, una minúscula y un número.',
    generate: () => `Suerte${Math.floor(1000 + Math.random() * 9000)}`,
  },
  testConnection,
  createPlayer,
  deposit,
  playerBalance,
};
