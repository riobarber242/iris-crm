// src/lib/casino/client.ts
// Todas las llamadas al casino (admin.celuapuestas.bond) pasan por un Cloudflare
// Worker proxy (casino-proxy) que agrega Origin/Referer y desbloquea el acceso.
// El proxy se autentica con el header X-Proxy-Secret.

const PROXY_URL = process.env.CASINO_PROXY_URL!;
const PROXY_SECRET = process.env.CASINO_PROXY_SECRET ?? '';
const AGENT_USERNAME = process.env.CASINO_AGENT_USERNAME ?? 'gonza0106';
const AGENT_PASSWORD = process.env.CASINO_AGENT_PASSWORD ?? '';
const SKIN_DOMAIN = 'admin.celuapuestas.bond';

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

// Devuelve un access token válido del casino. Autentica con usuario+contraseña a
// través del proxy y cachea el token hasta su expiración (expireInSeconds) con un
// margen de 60s.
async function getCasinoToken(): Promise<string | null> {
  const now = Date.now();
  if (tokenCache && now < tokenCache.expiresAt) return tokenCache.token;

  if (!AGENT_PASSWORD) return null;

  try {
    const res = await fetch(`${PROXY_URL}/api/TokenAuth/Authenticate`, {
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

  const res = await fetch(url, { method: 'GET', headers: await casinoHeaders() });

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

export async function doDeposit(targetId: string, amount: number): Promise<DoDepositResult> {
  // El query param ?username= lleva el username del AGENTE (no el del player).
  const url = `${PROXY_URL}/api/services/app/Players/DoDeposit?username=${AGENT_USERNAME}`;

  const reqBody = JSON.stringify({ targetId: Number(targetId), amount });
  console.log('[Casino] DoDeposit URL:', url);
  console.log('[Casino] DoDeposit body completo:', reqBody);

  const res = await fetch(url, {
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
  const targetId = await getPlayerTargetId(username);
  if (!targetId) return { success: false, error: `Player no encontrado en el casino: ${username}` };

  return doDeposit(targetId, amount);
}
