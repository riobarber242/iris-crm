// src/lib/casino/client.ts
// Todas las llamadas al casino (admin.celuapuestas.bond) pasan por un Cloudflare
// Worker proxy (casino-proxy) que agrega Origin/Referer y desbloquea el acceso.
// El proxy se autentica con el header X-Proxy-Secret.

const PROXY_URL = process.env.CASINO_PROXY_URL!;
const PROXY_SECRET = process.env.CASINO_PROXY_SECRET ?? '';
const AGENT_USERNAME = process.env.CASINO_AGENT_USERNAME ?? 'gonza0106';
const AGENT_ID = process.env.CASINO_AGENT_ID ?? 'cmoj1nya83zdnmhqizvk1hpbt';
const AGENT_PASSWORD = process.env.CASINO_AGENT_PASSWORD ?? '';
const SKIN_DOMAIN = 'admin.celuapuestas.bond';
// skinId fijo de CeluApuestas (Casino 17Star). Lo exige AddPlayer.
const SKIN_ID = process.env.CASINO_SKIN_ID ?? 'eeafa00307a1';

// Cache en memoria del access token (por instancia/lambda). Se renueva vía
// TokenAuth/Authenticate cuando vence, con un margen de 60s.
let tokenCache: { token: string; expiresAt: number } | null = null;

// Header común que autentica cada request contra el Worker proxy.
function proxyHeaders(extra?: Record<string, string>) {
  return {
    'Content-Type': 'application/json',
    'X-Proxy-Secret': PROXY_SECRET,
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

// Devuelve un access token válido del casino. Autentica con usuario+contraseña a
// través del proxy y cachea el token hasta su expiración (expireInSeconds) con un
// margen de 60s.
async function getCasinoToken(): Promise<string | null> {
  const now = Date.now();
  if (tokenCache && now < tokenCache.expiresAt) return tokenCache.token;

  if (!AGENT_PASSWORD) return null;

  try {
    const res = await casinoFetch(`${PROXY_URL}/api/TokenAuth/Authenticate`, {
      method: 'POST',
      headers: proxyHeaders(),
      body: JSON.stringify({
        userNameOrEmailAddress: AGENT_USERNAME,
        password: AGENT_PASSWORD,
        skinDomain: SKIN_DOMAIN,
      }),
    });

    const rawBody = await res.text().catch(() => '');
    console.log(`[Casino] Authenticate status=${res.status} — body(500):`, rawBody.slice(0, 500));

    if (!res.ok) return null;

    let data: any = null;
    try {
      data = JSON.parse(rawBody);
    } catch {
      console.error('[Casino] Authenticate: body no es JSON (¿HTML?)');
      return null;
    }
    const token: string | null = data?.result?.accessToken ?? null;
    const expireInSeconds = Number(data?.result?.expireInSeconds ?? 0);
    if (!token) {
      console.error('[Casino] Authenticate no devolvió accessToken');
      return null;
    }
    console.log('[Casino] accessToken (20):', String(token).slice(0, 20));
    // Margen de 60s para no usar un token a punto de vencer.
    const ttlMs = (expireInSeconds > 60 ? expireInSeconds - 60 : Math.max(expireInSeconds, 0)) * 1000;
    tokenCache = { token, expiresAt: now + ttlMs };
    return token;
  } catch (err: any) {
    console.error('[Casino] Authenticate error:', err?.message ?? err);
    return null;
  }
}

async function casinoHeaders() {
  const token = await getCasinoToken();
  return proxyHeaders({ 'Authorization': `Bearer ${token}` });
}

// Saldo de fichas del agente del casino (gonza0106). Baja al verificar cargas
// (deposita a un jugador) y sube al verificar pagos. Endpoint:
//   GET /api/services/app/Agent/GetAgentBalance?agentId=...&username=...
// Respuesta: { result: <number>, success: true }. Devuelve null si falla.
export async function getAgentBalance(): Promise<number | null> {
  const params = new URLSearchParams({ agentId: AGENT_ID, username: AGENT_USERNAME });
  const url = `${PROXY_URL}/api/services/app/Agent/GetAgentBalance?${params}`;

  try {
    const res = await casinoFetch(url, { method: 'GET', headers: await casinoHeaders() });
    if (!res.ok) {
      console.error(`[Casino] GetAgentBalance HTTP ${res.status}`);
      return null;
    }
    const text = await res.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      console.error('[Casino] GetAgentBalance: body no es JSON (¿HTML/bloqueo?) — primeros 200:', text.slice(0, 200));
      return null;
    }
    const balance = Number(data?.result);
    return Number.isFinite(balance) ? balance : null;
  } catch (err: any) {
    console.error('[Casino] GetAgentBalance error:', err?.message ?? err);
    return null;
  }
}

export async function getPlayerTargetId(username: string): Promise<string | null> {
  const params = new URLSearchParams({
    parentId: '-1',
    username: AGENT_USERNAME,
    userId: 'NaN',
    userType: '2',
    searchText: username,
    onlyHidden: 'false',
    offset: '0',
    rowQty: '20',
    searchInAllTree: 'true',
  });

  const url = `${PROXY_URL}/api/services/app/Agent/GetAgentWithChildren?${params}`;

  const res = await casinoFetch(url, { method: 'GET', headers: await casinoHeaders() });

  if (!res.ok) {
    console.error(`[Casino] GetAgentWithChildren HTTP ${res.status}`);
    return null;
  }

  // Logueamos el body RAW antes de parsear: si el casino bloquea la IP de
  // egress (Vercel/US) devuelve su SPA en HTML con status 200, y JSON.parse
  // tiraría un error no capturado (→ 500). Con esto vemos exactamente qué llega.
  const text = await res.text();
  console.log('[Casino] GetAgentWithChildren raw body (200 chars):', text.slice(0, 200));
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    console.error('[Casino] GetAgentWithChildren: body no es JSON (¿HTML/bloqueo?) — primeros 500:', text.slice(0, 500));
    return null;
  }
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

export async function doDeposit(params: { username: string; targetId: string; amount: number }): Promise<DoDepositResult> {
  // El query param ?username= lleva el username del AGENTE (no el del player).
  const url = `${PROXY_URL}/api/services/app/Players/DoDeposit?username=${AGENT_USERNAME}`;

  // Body COMPLETO con contexto del agente. El casino lo exige: con el body
  // simplificado { targetId, amount } devuelve "Entidad no encontrada"; con este
  // devuelve 201 "Deposit Succesfull" (verificado en prod). targetId = accountId
  // (número), NO el userId string.
  const reqBody = JSON.stringify({
    username: params.username,
    userName: params.username,
    userType: 1,
    agentId: AGENT_ID,
    agentUserName: AGENT_USERNAME,
    amount: params.amount,
    targetId: Number(params.targetId),
  });
  console.log('[Casino] DoDeposit URL:', url);
  console.log('[Casino] DoDeposit body completo:', reqBody);

  const res = await casinoFetch(url, {
    method: 'POST',
    headers: await casinoHeaders(),
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

export async function creditPlayer(username: string, amount: number): Promise<DoDepositResult> {
  // getPlayerTargetId / doDeposit pueden lanzar (incluido el timeout de casinoFetch).
  // Lo convertimos en un resultado para que el flujo de verificar comprobantes
  // responda un 400 limpio ("La recarga NO se verificó") en vez de un 500.
  try {
    const targetId = await getPlayerTargetId(username);
    if (!targetId) return { success: false, error: `Player no encontrado en el casino: ${username}` };

    return await doDeposit({ username, targetId, amount });
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
export async function createPlayer(userName: string, password: string): Promise<CreatePlayerResult> {
  const url = `${PROXY_URL}/api/services/app/Players/AddPlayer`;
  const reqBody = JSON.stringify({ userName, password, skinIds: [SKIN_ID] });
  console.log('[Casino] AddPlayer URL:', url, '— userName:', userName);

  let res: Response;
  try {
    res = await casinoFetch(url, { method: 'POST', headers: await casinoHeaders(), body: reqBody }, ADDPLAYER_TIMEOUT_MS);
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
