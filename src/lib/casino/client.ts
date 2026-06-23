// src/lib/casino/client.ts
// Endpoints verificados el 23/06/2026 capturando requests reales del panel admin.celuapuestas.bond

const CASINO_BASE_URL = process.env.CASINO_API_BASE_URL!;
const AGENT_USERNAME = process.env.CASINO_AGENT_USERNAME ?? 'gonza0106';
const AGENT_ID = process.env.CASINO_AGENT_ID ?? 'cmoj1nya83zdnmhqizvk1hpbt';
const AGENT_PASSWORD = process.env.CASINO_AGENT_PASSWORD ?? '';

// Cache en memoria del access token (por instancia/lambda). Se renueva vía
// TokenAuth/Authenticate cuando vence, con un margen de 60s.
let tokenCache: { token: string; expiresAt: number } | null = null;

// Devuelve un access token válido del casino. Autentica con usuario+contraseña y
// cachea el token hasta su expiración (expireInSeconds). Fallback: si NO hay
// contraseña configurada, usa el token estático de env (CASINO_API_TOKEN).
async function getCasinoToken(): Promise<string | null> {
  const now = Date.now();
  if (tokenCache && now < tokenCache.expiresAt) return tokenCache.token;

  if (!AGENT_PASSWORD) return process.env.CASINO_API_TOKEN ?? null;

  try {
    const res = await fetch(`${CASINO_BASE_URL}/api/TokenAuth/Authenticate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usernameOrEmailAddress: AGENT_USERNAME, password: AGENT_PASSWORD }),
    });
    if (!res.ok) {
      // Log temporal de diagnóstico: status + primeros 200 chars del body. NO
      // expone la password (está en el request, no en la respuesta).
      const body = await res.text().catch(() => '');
      console.error(`[Casino] Authenticate HTTP ${res.status} — body:`, body.slice(0, 200));
      return null;
    }
    const data = await res.json();
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
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
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
    searchInAllTree: 'false',
  });

  const url = `${CASINO_BASE_URL}/api/services/app/Agent/GetAgentWithChildren?${params}`;

  const res = await fetch(url, { method: 'GET', headers: await casinoHeaders() });

  if (!res.ok) {
    console.error(`[Casino] GetAgentWithChildren HTTP ${res.status}`);
    return null;
  }

  const data = await res.json();
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

  const targetId = player?.id ?? player?.Id ?? player?.userId ?? player?.targetId ?? null;
  console.log(`[Casino] targetId: ${targetId}`);
  return targetId ? String(targetId) : null;
}

export interface DoDepositResult {
  success: boolean;
  error?: string;
}

export async function doDeposit(params: {
  username: string;
  userName: string;
  userType: number;
  agentId: string;
  agentUserName: string;
  amount: number;
  targetId: string;
}): Promise<DoDepositResult> {
  const url = `${CASINO_BASE_URL}/api/services/app/Players/DoDeposit?username=${AGENT_USERNAME}`;

  const reqBody = JSON.stringify(params);
  console.log('[Casino] DoDeposit body:', reqBody);

  const res = await fetch(url, {
    method: 'POST',
    headers: await casinoHeaders(),
    body: reqBody,
  });

  const respText = await res.text().catch(() => '');
  console.log(`[Casino] DoDeposit resp status=${res.status} body:`, respText.slice(0, 1000));

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

  return doDeposit({
    username,
    userName: username,
    userType: 1,
    agentId: AGENT_ID,
    agentUserName: AGENT_USERNAME,
    amount,
    targetId,
  });
}
