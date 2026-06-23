// src/lib/casino/client.ts
// Endpoints verificados el 23/06/2026 capturando requests reales del panel admin.celuapuestas.bond

const CASINO_BASE_URL = process.env.CASINO_API_BASE_URL!;
const CASINO_TOKEN = process.env.CASINO_API_TOKEN!;
const AGENT_USERNAME = process.env.CASINO_AGENT_USERNAME ?? 'gonza0106';
const AGENT_ID = process.env.CASINO_AGENT_ID ?? 'cmoj1nya83zdnmhqizvk1hpbt';

function casinoHeaders() {
  return {
    'Authorization': `Bearer ${CASINO_TOKEN}`,
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

  const res = await fetch(url, { method: 'GET', headers: casinoHeaders() });

  if (!res.ok) {
    console.error(`[Casino] GetAgentWithChildren HTTP ${res.status}`);
    return null;
  }

  const data = await res.json();
  console.log('[Casino] GetAgentWithChildren shape:', JSON.stringify(data, null, 2).substring(0, 2000));

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

  const res = await fetch(url, {
    method: 'POST',
    headers: casinoHeaders(),
    body: JSON.stringify(params),
  });

  if (res.status === 201) return { success: true };

  let errorBody = '';
  try {
    const text = await res.text();
    if (text.trim().startsWith('{')) {
      const json = JSON.parse(text);
      errorBody = json?.error?.message ?? json?.message ?? text.substring(0, 200);
    } else {
      errorBody = `HTTP ${res.status} - respuesta no JSON`;
    }
  } catch {
    errorBody = `HTTP ${res.status}`;
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
