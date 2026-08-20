// src/lib/casino/client.ts
// Todas las llamadas al casino pasan por un Cloudflare Worker proxy (casino-proxy)
// que agrega Origin/Referer y desbloquea el acceso. El proxy se autentica con el
// header X-Proxy-Secret.
//
// Etapa 2, PR 2: el client ya NO conoce ninguna credencial de casino. Cada función
// recibe `creds: CasinoCreds` (usuario/id/password/skin del AGENTE de ESE tenant),
// resueltas por el route con resolveCasinoCreds(). Solo el proxy (URL + secret)
// sigue siendo global: es infraestructura compartida, no una credencial de casino.

import type { CasinoCreds } from './account';

const PROXY_URL = process.env.CASINO_PROXY_URL!;
const PROXY_SECRET = process.env.CASINO_PROXY_SECRET ?? '';

// Cache en memoria del access token (por instancia/lambda), keyed por
// skinDomain|agentUsername: cada agente/casino tiene su propio token. Se renueva
// vía TokenAuth/Authenticate cuando vence, con un margen de 60s.
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

// Header común que autentica cada request contra el Worker proxy. X-Casino-Target
// le dice al Worker a qué casino reenviar (el skin_domain del tenant); el Worker lo
// valida contra su allowlist. Etapa 2, PR 3: multi-tenant en el proxy.
function proxyHeaders(skinDomain: string, extra?: Record<string, string>) {
  return {
    'Content-Type': 'application/json',
    'X-Proxy-Secret': PROXY_SECRET,
    'X-Casino-Target': skinDomain,
    ...extra,
  };
}

// Corte duro de 8s: si el proxy/casino no responde, abortamos y lanzamos un error
// claro en vez de colgar la función serverless hasta el límite de Vercel.
const CASINO_TIMEOUT_MS = 8000;
// AddPlayer suele tardar más que un GET; le damos más margen para no abortar una
// creación que en realidad está por completar (evita usuarios duplicados).
const ADDPLAYER_TIMEOUT_MS = 15000;

async function casinoFetch(url: string, init: RequestInit, timeoutMs: number = CASINO_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err: any) {
    if (err?.name === 'AbortError') throw new Error('El casino no respondió a tiempo');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ── Reintento ante respuestas inservibles ─────────────────────────────────────
// El casino devuelve por rachas su propia SPA (HTML) con HTTP 200 en vez del JSON
// de la API: su ingress sirve el front-end cuando su backend de API no está.
// Verificado en los logs del 19/08/2026: el MISMO login alternaba 201+token y HTML
// con un minuto de diferencia. Dos reintentos cortos tapan esos hipos de decenas
// de segundos sin que se note del lado de IRIS.
//
// SOLO para operaciones idempotentes (Authenticate, GetAgentBalance,
// GetAgentWithChildren). DoDeposit y AddPlayer NO se reintentan NUNCA: acreditar
// dos veces o crear dos jugadores es peor que fallar.
const RETRY_DELAYS_MS = [500, 1500];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface CasinoJsonResult {
  res: Response | null;
  status: number;
  body: string;
  json: any | null;
  /** Llegó respuesta pero no es JSON usable (HTML de la SPA, texto suelto, vacío). */
  notJson: boolean;
  timedOut: boolean;
  attempts: number;
}

// Ante la duda SIEMPRE tratamos la falla como "el casino no pudo contestar", nunca
// como credencial mala. Un falso "contraseña incorrecta" hace que la gente la
// vuelva a tipear y termine pisando la buena: fue exactamente lo que pasó el
// 20/08/2026 (7 contraseñas distintas guardadas en 24 minutos mientras el casino
// devolvía HTML de forma intermitente).
const CRED_ERROR_RE = /invalid|incorrect|wrong|credential|credencial|password|contrase|user ?name|usuario|login/i;

// ¿El casino dijo explícitamente que la credencial está mal? ABP manda ese rechazo
// con 401 y también con 500, así que el status solo no alcanza.
function isCredRejection(r: CasinoJsonResult): boolean {
  if (r.notJson || !r.json) return false;
  const msg = [r.json?.error?.message, r.json?.error?.details].filter(Boolean).join(' ');
  return !!msg && CRED_ERROR_RE.test(msg);
}

// 401/403 y los rechazos explícitos de credenciales NO se reintentan: además de
// inútil, insistir con una credencial rechazada es lo que dispara lockouts del
// lado del casino.
function isTransient(r: CasinoJsonResult): boolean {
  if (r.status === 401 || r.status === 403) return false;
  if (isCredRejection(r)) return false;
  return r.notJson || r.status === 429 || r.status >= 500;
}

// Wrapper de casinoFetch que además parsea el JSON y reintenta las fallas
// transitorias. `init.body` es siempre un string en este módulo, así que se puede
// reenviar tal cual en cada intento.
async function casinoFetchJson(
  url: string,
  init: RequestInit,
  opts: { label: string; timeoutMs?: number },
): Promise<CasinoJsonResult> {
  let last: CasinoJsonResult = {
    res: null, status: 0, body: '', json: null, notJson: false, timedOut: false, attempts: 0,
  };

  for (let attempt = 1; attempt <= RETRY_DELAYS_MS.length + 1; attempt++) {
    try {
      const res = await casinoFetch(url, init, opts.timeoutMs);
      const body = await res.text().catch(() => '');
      let json: any = null;
      try { json = JSON.parse(body); } catch { /* no-JSON → notJson */ }
      last = { res, status: res.status, body, json, notJson: json === null, timedOut: false, attempts: attempt };
    } catch (err: any) {
      const timedOut = err?.message === 'El casino no respondió a tiempo';
      last = {
        res: null, status: 0, body: err?.message ?? 'error de red', json: null,
        notJson: false, timedOut, attempts: attempt,
      };
      // Un timeout ya se comió CASINO_TIMEOUT_MS enteros: reintentar arriesga que
      // Vercel mate la función. Se devuelve tal cual.
      if (timedOut) return last;
    }

    if (!isTransient(last)) return last;
    const delay = RETRY_DELAYS_MS[attempt - 1];
    if (delay === undefined) break;
    console.warn(
      `[Casino] ${opts.label}: respuesta inservible (http=${last.status}${last.notJson ? ', body no-JSON' : ''})` +
      ` — reintento ${attempt}/${RETRY_DELAYS_MS.length} en ${delay}ms`,
    );
    await sleep(delay);
  }
  return last;
}

// Devuelve un access token válido del casino para ESTAS credenciales. Autentica
// con usuario+contraseña a través del proxy y cachea el token hasta su expiración
// (expireInSeconds) con un margen de 60s. El cache es por skinDomain|agentUsername.
async function getCasinoToken(creds: CasinoCreds): Promise<string | null> {
  const now = Date.now();
  const cacheKey = `${creds.skinDomain}|${creds.agentUsername}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && now < cached.expiresAt) return cached.token;

  if (!creds.agentPassword) return null;

  try {
    const r = await casinoFetchJson(`${PROXY_URL}/api/TokenAuth/Authenticate`, {
      method: 'POST',
      headers: proxyHeaders(creds.skinDomain),
      body: JSON.stringify({
        userNameOrEmailAddress: creds.agentUsername,
        password: creds.agentPassword,
        skinDomain: creds.skinDomain,
      }),
    }, { label: 'Authenticate' });

    console.log(`[Casino] Authenticate http=${r.status} intentos=${r.attempts} — body(500):`, r.body.slice(0, 500));

    if (r.timedOut) {
      console.error('[Casino] Authenticate: el casino no respondió a tiempo');
      return null;
    }
    if (r.notJson) {
      console.error(`[Casino] Authenticate: body no es JSON (¿HTML?) tras ${r.attempts} intento(s)`);
      return null;
    }
    if (r.status >= 400) return null;

    const data = r.json;
    const token: string | null = data?.result?.accessToken ?? null;
    const expireInSeconds = Number(data?.result?.expireInSeconds ?? 0);
    if (!token) {
      console.error('[Casino] Authenticate no devolvió accessToken');
      return null;
    }
    console.log('[Casino] accessToken (20):', String(token).slice(0, 20));
    // Margen de 60s para no usar un token a punto de vencer.
    const ttlMs = (expireInSeconds > 60 ? expireInSeconds - 60 : Math.max(expireInSeconds, 0)) * 1000;
    tokenCache.set(cacheKey, { token, expiresAt: now + ttlMs });
    return token;
  } catch (err: any) {
    console.error('[Casino] Authenticate error:', err?.message ?? err);
    return null;
  }
}

async function casinoHeaders(creds: CasinoCreds) {
  const token = await getCasinoToken(creds);
  return proxyHeaders(creds.skinDomain, { 'Authorization': `Bearer ${token}` });
}

// Saldo de fichas del agente del casino del tenant. Baja al verificar cargas
// (deposita a un jugador) y sube al verificar pagos. Endpoint:
//   GET /api/services/app/Agent/GetAgentBalance?agentId=...&username=...
// Respuesta: { result: <number>, success: true }. Devuelve null si falla.
export async function getAgentBalance(creds: CasinoCreds): Promise<number | null> {
  const params = new URLSearchParams({ agentId: creds.agentId, username: creds.agentUsername });
  const url = `${PROXY_URL}/api/services/app/Agent/GetAgentBalance?${params}`;

  try {
    const r = await casinoFetchJson(url, { method: 'GET', headers: await casinoHeaders(creds) }, { label: 'GetAgentBalance' });
    if (r.timedOut) {
      console.error('[Casino] GetAgentBalance: el casino no respondió a tiempo');
      return null;
    }
    if (r.notJson) {
      console.error(`[Casino] GetAgentBalance: body no es JSON (¿HTML/bloqueo?) tras ${r.attempts} intento(s) — primeros 200:`, r.body.slice(0, 200));
      return null;
    }
    if (r.status >= 400) {
      console.error(`[Casino] GetAgentBalance HTTP ${r.status}`);
      return null;
    }
    const balance = Number(r.json?.result);
    return Number.isFinite(balance) ? balance : null;
  } catch (err: any) {
    console.error('[Casino] GetAgentBalance error:', err?.message ?? err);
    return null;
  }
}

export async function getPlayerTargetId(creds: CasinoCreds, username: string): Promise<string | null> {
  const params = new URLSearchParams({
    parentId: '-1',
    username: creds.agentUsername,
    userId: 'NaN',
    userType: '2',
    searchText: username,
    onlyHidden: 'false',
    offset: '0',
    rowQty: '20',
    searchInAllTree: 'true',
  });

  const url = `${PROXY_URL}/api/services/app/Agent/GetAgentWithChildren?${params}`;

  // Logueamos el body RAW: cuando el casino sirve su SPA en HTML con status 200
  // (ver casinoFetchJson), esto muestra exactamente qué llegó. La búsqueda del
  // player es idempotente, así que se reintenta.
  const r = await casinoFetchJson(url, { method: 'GET', headers: await casinoHeaders(creds) }, { label: 'GetAgentWithChildren' });
  console.log(`[Casino] GetAgentWithChildren raw body (200 chars, intentos=${r.attempts}):`, r.body.slice(0, 200));

  if (r.timedOut) {
    console.error('[Casino] GetAgentWithChildren: el casino no respondió a tiempo');
    return null;
  }
  if (r.notJson) {
    console.error(`[Casino] GetAgentWithChildren: body no es JSON (¿HTML/bloqueo?) tras ${r.attempts} intento(s) — primeros 500:`, r.body.slice(0, 500));
    return null;
  }
  if (r.status >= 400) {
    console.error(`[Casino] GetAgentWithChildren HTTP ${r.status}`);
    return null;
  }

  const data = r.json;
  console.log('[Casino] GetAgentWithChildren shape:', JSON.stringify(data, null, 2).substring(0, 3000));

  let items: any[] = [];
  if (Array.isArray(data)) items = data;
  else if (Array.isArray(data?.result)) items = data.result;
  else if (Array.isArray(data?.result?.items)) items = data.result.items;
  else if (Array.isArray(data?.items)) items = data.items;
  else if (Array.isArray(data?.data)) items = data.data;

  console.log(`[Casino] items: ${items.length}, buscando: ${username}`);

  const player = items.find((p: any) =>
    (p?.userName ?? p?.username ?? p?.UserName ?? '') === username
  );

  if (!player) {
    console.error(`[Casino] Player "${username}" no encontrado. Primeros 3:`, items.slice(0, 3));
    return null;
  }

  // El campo correcto del response de GetAgentWithChildren es accountId (número,
  // ej: 19923006), NO userId. Ese accountId es el targetId que espera DoDeposit.
  const accountId = player?.accountId ?? player?.AccountId ?? null;
  console.log(`[Casino] accountId extraído: ${accountId} (player.userName=${player?.userName ?? player?.UserName})`);
  return accountId != null ? String(accountId) : null;
}

export interface DoDepositResult {
  success: boolean;
  error?: string;
}

export async function doDeposit(creds: CasinoCreds, params: { username: string; targetId: string; amount: number }): Promise<DoDepositResult> {
  // El query param ?username= lleva el username del AGENTE (no el del player).
  const url = `${PROXY_URL}/api/services/app/Players/DoDeposit?username=${creds.agentUsername}`;

  // Body COMPLETO con contexto del agente. El casino lo exige: con el body
  // simplificado { targetId, amount } devuelve "Entidad no encontrada"; con este
  // devuelve 201 "Deposit Succesfull" (verificado en prod). targetId = accountId
  // (número), NO el userId string.
  const reqBody = JSON.stringify({
    username: params.username,
    userName: params.username,
    userType: 1,
    agentId: creds.agentId,
    agentUserName: creds.agentUsername,
    amount: params.amount,
    targetId: Number(params.targetId),
  });
  console.log('[Casino] DoDeposit URL:', url);
  console.log('[Casino] DoDeposit body completo:', reqBody);

  const res = await casinoFetch(url, {
    method: 'POST',
    headers: await casinoHeaders(creds),
    body: reqBody,
  });

  const respText = await res.text().catch(() => '');
  console.log(`[Casino] DoDeposit resp status=${res.status} body completo:`, respText);

  if (res.status === 201) return { success: true };

  let errorBody = '';
  if (respText.trim().startsWith('{')) {
    try {
      const json = JSON.parse(respText);
      errorBody = json?.error?.message ?? json?.message ?? respText.substring(0, 200);
    } catch {
      errorBody = respText.substring(0, 200);
    }
  } else {
    errorBody = `HTTP ${res.status} - respuesta no JSON`;
  }

  console.error(`[Casino] DoDeposit falló: ${errorBody}`);
  return { success: false, error: errorBody };
}

export async function creditPlayer(creds: CasinoCreds, username: string, amount: number): Promise<DoDepositResult> {
  // getPlayerTargetId / doDeposit pueden lanzar (incluido el timeout de casinoFetch).
  // Lo convertimos en un resultado para que el flujo de verificar comprobantes
  // responda un 400 limpio ("La recarga NO se verificó") en vez de un 500.
  try {
    const targetId = await getPlayerTargetId(creds, username);
    if (!targetId) return { success: false, error: `Player no encontrado en el casino: ${username}` };

    return await doDeposit(creds, { username, targetId, amount });
  } catch (err: any) {
    console.error('[Casino] creditPlayer error:', err?.message ?? err);
    return { success: false, error: err?.message ?? 'Error al acreditar en el casino' };
  }
}

export interface CreatePlayerResult {
  success: boolean;
  username?: string;
  error?: string;
  /** El casino rechazó por nombre de usuario ya existente (para reintentar correlativo). */
  taken?: boolean;
}

// Crea un jugador en el casino. POST /api/services/app/Players/AddPlayer con
// { userName, password, skinIds: [SKIN_ID] }. Devuelve success en status 201.
// La contraseña debe tener ≥8 chars, 1 dígito, 1 mayúscula y 1 minúscula.
export async function createPlayer(creds: CasinoCreds, userName: string, password: string): Promise<CreatePlayerResult> {
  const url = `${PROXY_URL}/api/services/app/Players/AddPlayer`;
  const reqBody = JSON.stringify({ userName, password, skinIds: [creds.skinId] });
  console.log('[Casino] AddPlayer URL:', url, '— userName:', userName);

  let res: Response;
  try {
    res = await casinoFetch(url, { method: 'POST', headers: await casinoHeaders(creds), body: reqBody }, ADDPLAYER_TIMEOUT_MS);
  } catch (err: any) {
    console.error('[Casino] AddPlayer error de red:', err?.message ?? err);
    return { success: false, error: err?.message ?? 'Error de red al crear el usuario en el casino' };
  }

  const respText = await res.text().catch(() => '');
  console.log(`[Casino] AddPlayer resp status=${res.status} body:`, respText.slice(0, 500));

  if (res.status === 201) return { success: true, username: userName };

  let errorBody = '';
  if (respText.trim().startsWith('{')) {
    try {
      const json = JSON.parse(respText);
      errorBody = json?.error?.message ?? json?.message ?? respText.slice(0, 200);
    } catch {
      errorBody = respText.slice(0, 200);
    }
  } else {
    errorBody = `HTTP ${res.status} - respuesta no JSON`;
  }

  // Heurística para detectar "usuario ya existe" y poder reintentar correlativo.
  const taken = /exist|registr|ya .*us|taken|duplicad|en uso/i.test(errorBody);
  console.error(`[Casino] AddPlayer falló: ${errorBody}${taken ? ' (usuario tomado)' : ''}`);
  return { success: false, error: errorBody, taken };
}

// ── Test de conexión (Etapa 2, PR 4) ─────────────────────────────────────────
// Diagnóstico de credenciales para /api/casino/test-connection. A diferencia de
// getAgentBalance (que colapsa todo a null en el hot-path del depósito), DISTINGUE
// cada modo de falla para dar un mensaje específico en el form. NO toca tokenCache:
// usa el token fresco de SU propio Authenticate (probamos credenciales sin guardar,
// y no queremos envenenar el cache del flujo real).
export type CasinoTestFailReason =
  | 'bad_credentials'      // el casino RECHAZÓ el login (lo dijo él, no lo inferimos)
  | 'casino_unavailable'   // HTML de la SPA, 5xx, 429, body raro → NO es la contraseña
  | 'agent_not_found'
  | 'forbidden_target'
  | 'proxy_secret'
  | 'timeout'
  | 'unknown';

export type CasinoTestResult =
  | { ok: true; agentName: string; balance: number; authResultKeys: string[] }
  | { ok: false; reason: CasinoTestFailReason; detail?: string };

// Traduce una falla a su causa. Solo 'bad_credentials' habla de la contraseña, y
// se llega ahí únicamente si el casino lo dijo él mismo (ver isCredRejection).
function classifyFailure(r: CasinoJsonResult): CasinoTestFailReason {
  if (r.timedOut) return 'timeout';
  // 401 = rechazo de autenticación, tenga body o no. Va ANTES del chequeo de
  // notJson: este casino contesta un login malo con 401 y content-length 0
  // (verificado el 20/08/2026), así que con el orden inverso el body vacío se
  // comía el caso y una contraseña mal de verdad salía como "casino caído".
  // El 401 del Worker (X-Proxy-Secret inválido) ya se filtró antes de llegar acá.
  if (r.status === 401) return 'bad_credentials';
  // El 403 queda abajo a propósito: un 403 con HTML es casi siempre un WAF o un
  // bloqueo del casino, no una credencial.
  if (r.notJson) return 'casino_unavailable';   // ← el caso de los logs del 19-20/08
  // El casino contestó JSON bien formado: su propio mensaje de error manda por
  // encima del status (ABP devuelve el rechazo de login también con 500).
  if (isCredRejection(r)) return 'bad_credentials';
  if (r.status === 403) return 'bad_credentials';
  if (r.status === 429 || r.status >= 500)  return 'casino_unavailable';
  return 'unknown';
}

// Nunca loguea la contraseña. Sin esto los intentos fallidos eran invisibles:
// testCasinoConnection solo logueaba en el éxito, así que los tests de las 14:05 y
// 14:26 del 20/08 no dejaron ni una línea.
function logTestFailure(creds: CasinoCreds, stage: string, reason: string, r: CasinoJsonResult) {
  console.error(
    `[Casino] test-connection FALLÓ stage=${stage} reason=${reason} tenant=${creds.tenantId} ` +
    `agente=${creds.agentUsername} target=${creds.skinDomain} http=${r.status} intentos=${r.attempts} ` +
    `content-type=${r.res?.headers.get('content-type') ?? '-'} — body(300): ${r.body.slice(0, 300).replace(/\s+/g, ' ')}`,
  );
}

export async function testCasinoConnection(creds: CasinoCreds): Promise<CasinoTestResult> {
  // ── 1) Authenticate (login del agente) ──────────────────────────────────────
  const a = await casinoFetchJson(`${PROXY_URL}/api/TokenAuth/Authenticate`, {
    method: 'POST',
    headers: proxyHeaders(creds.skinDomain),
    body: JSON.stringify({
      userNameOrEmailAddress: creds.agentUsername,
      password: creds.agentPassword,
      skinDomain: creds.skinDomain,
    }),
  }, { label: 'test/Authenticate' });

  // Rechazos del WORKER (texto plano), antes de clasificar nada del casino.
  // 403 = el skin_domain no está en el allowlist ("casino todavía no habilitado").
  if (a.status === 403 && /forbidden casino target/i.test(a.body)) {
    logTestFailure(creds, 'Authenticate', 'forbidden_target', a);
    return { ok: false, reason: 'forbidden_target' };
  }
  // 401 "Unauthorized" texto plano = X-Proxy-Secret inválido (infra, no credenciales).
  if (a.status === 401 && /^unauthorized$/i.test(a.body.trim())) {
    logTestFailure(creds, 'Authenticate', 'proxy_secret', a);
    return { ok: false, reason: 'proxy_secret', detail: 'Proxy secret inválido' };
  }

  const token: string | null = a.json?.result?.accessToken ?? null;
  if (!token) {
    // Antes TODO esto caía en bad_credentials → "Usuario o contraseña incorrectos"
    // aunque el casino estuviera devolviendo HTML. Ahora se distingue la causa.
    const reason = classifyFailure(a);
    logTestFailure(creds, 'Authenticate', reason, a);
    return { ok: false, reason };
  }

  // Solo los NOMBRES de campos del result (sin valores/tokens): confirma si
  // Authenticate ya trae agentId/skinId (pregunta de diseño del PR 4).
  const authResultKeys =
    a.json?.result && typeof a.json.result === 'object' ? Object.keys(a.json.result) : [];

  // ── 2) GetAgentBalance (prueba concreta: saldo real del agente) ──────────────
  const params = new URLSearchParams({ agentId: creds.agentId, username: creds.agentUsername });
  const b = await casinoFetchJson(
    `${PROXY_URL}/api/services/app/Agent/GetAgentBalance?${params}`,
    { method: 'GET', headers: proxyHeaders(creds.skinDomain, { Authorization: `Bearer ${token}` }) },
    { label: 'test/GetAgentBalance' },
  );

  if (b.status === 403 && /forbidden casino target/i.test(b.body)) {
    logTestFailure(creds, 'GetAgentBalance', 'forbidden_target', b);
    return { ok: false, reason: 'forbidden_target' };
  }
  // El saldo arrastraba el mismo bug que el login: si volvía HTML decía "no
  // encontramos ese ID de agente". Pasó el 19/08 22:42:51 (login OK + saldo HTML).
  if (b.timedOut || b.notJson || b.status === 429 || b.status >= 500) {
    const reason: CasinoTestFailReason = b.timedOut ? 'timeout' : 'casino_unavailable';
    logTestFailure(creds, 'GetAgentBalance', reason, b);
    return { ok: false, reason };
  }

  const balance = Number(b.json?.result);
  if (!Number.isFinite(balance)) {
    // Recién acá: el casino contestó JSON bien formado y aun así no hay saldo →
    // el agentId no existe / no cuelga de este login. Ese sí es de configuración.
    logTestFailure(creds, 'GetAgentBalance', 'agent_not_found', b);
    return { ok: false, reason: 'agent_not_found', detail: b.body.slice(0, 200) };
  }

  console.log(
    `[Casino] test-connection OK tenant=${creds.tenantId} agente=${creds.agentUsername} ` +
    `target=${creds.skinDomain} saldo=${balance} intentos=auth:${a.attempts}/bal:${b.attempts} ` +
    `result keys: ${authResultKeys.join(', ')}`,
  );
  return { ok: true, agentName: creds.agentUsername, balance, authResultKeys };
}
