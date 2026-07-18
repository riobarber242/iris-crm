// src/lib/casino/account.ts
// Etapa 2, PR 2 — resolución de credenciales del casino POR TENANT.
//
// Reemplaza el modelo mono-cuenta (env vars globales gonza0106 / CeluApuestas que
// el client leía sin distinguir tenant) por la fila de casino_accounts del tenant.
// El client (client.ts) ya no conoce ninguna credencial: la recibe resuelta acá.
//
// resolveCasinoCreds() es el punto de entrada de los route handlers: devuelve la
// fila del tenant o null. Etapa 2, PR 6 — FAIL-CLOSED: se cortó el fallback a las
// env globales (gonza0106). Un tenant sin fila ya NO cae a las credenciales de otro
// casino; los callers devuelven "Casino no configurado". Censo previo al corte: el
// único tenant con casino_deposit_enabled='true' (17Star) tiene su fila verificada,
// así que el corte no cambia el comportamiento de nadie en producción.

import { supabaseAdmin } from '@/lib/db';
import { decryptSecret } from '@/lib/secure-secret';

// Credenciales atómicas de UNA conexión de casino, ya en claro y listas para
// usar. Nunca se logean ni se serializan enteras (llevan el password del agente).
export interface CasinoCreds {
  agentUsername: string;
  agentId:       string;
  agentPassword: string;
  skinId:        string;
  skinDomain:    string;
  tenantId:      string;
}

// Lee la conexión activa + default de casino_accounts del tenant, descifra el
// password del agente y devuelve las credenciales. Fail-closed: si no hay fila,
// falta el blob cifrado, o el descifrado falla (clave equivocada / dato
// manipulado), devuelve null en vez de credenciales a medias.
export async function loadCasinoAccount(tenantId: string): Promise<CasinoCreds | null> {
  const { data, error } = await supabaseAdmin
    .from('casino_accounts')
    .select('tenant_id, agent_username, agent_id, skin_id, skin_domain, agent_password_enc')
    .eq('tenant_id', tenantId)
    .eq('is_default', true)
    .eq('active', true)
    .maybeSingle();

  if (error) {
    console.error(`[casino] loadCasinoAccount error tenant=${tenantId}:`, error.message);
    return null;
  }
  if (!data) return null;
  if (!data.agent_password_enc) {
    console.error(`[casino] loadCasinoAccount: fila sin agent_password_enc tenant=${tenantId}`);
    return null;
  }

  let agentPassword: string;
  try {
    agentPassword = decryptSecret(data.agent_password_enc);
  } catch (err: any) {
    // Clave de cifrado equivocada o blob manipulado: no seguimos con un secreto
    // inválido (autenticaría mal o expondría el error crudo).
    console.error(`[casino] loadCasinoAccount: no se pudo descifrar agent_password_enc tenant=${tenantId}:`, err?.message ?? err);
    return null;
  }

  return {
    agentUsername: data.agent_username,
    agentId:       data.agent_id,
    agentPassword,
    skinId:        data.skin_id,
    skinDomain:    data.skin_domain,
    tenantId:      data.tenant_id,
  };
}

// Punto de entrada de los routes: SOLO la fila de casino_accounts del tenant.
// Devuelve null si no hay fila (→ los callers responden "Casino no configurado").
// PR 6: se eliminó el fallback a las env globales — un tenant sin fila jamás
// opera con las credenciales de otro casino (fail-closed).
export async function resolveCasinoCreds(tenantId: string): Promise<CasinoCreds | null> {
  return loadCasinoAccount(tenantId);
}
