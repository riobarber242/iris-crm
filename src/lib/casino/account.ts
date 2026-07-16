// src/lib/casino/account.ts
// Etapa 2, PR 2 — resolución de credenciales del casino POR TENANT.
//
// Reemplaza el modelo mono-cuenta (env vars globales gonza0106 / CeluApuestas que
// el client leía sin distinguir tenant) por la fila de casino_accounts del tenant.
// El client (client.ts) ya no conoce ninguna credencial: la recibe resuelta acá.
//
// resolveCasinoCreds() es el punto de entrada de los route handlers: devuelve la
// fila del tenant y, si todavía no la tiene, cae a las env globales dejando un
// log FALLBACK-ENV. Ese fallback es TRANSITORIO (mientras conviven tenants ya
// migrados con otros que aún leen del env) y se corta en el PR 6.

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

// Credenciales desde las env vars GLOBALES (la cuenta mono-tenant de 17Star). Los
// defaults son los MISMOS que tenía client.ts y que usa el seed de migrate-global,
// así que para 17Star el resultado es idéntico. TRANSITORIO: se elimina en el PR 6
// cuando toda conexión viva en casino_accounts. Fail-closed si falta el password.
export function envCasinoCreds(tenantId: string): CasinoCreds | null {
  const agentPassword = process.env.CASINO_AGENT_PASSWORD ?? '';
  if (!agentPassword) return null;

  return {
    agentUsername: process.env.CASINO_AGENT_USERNAME ?? 'gonza0106',
    agentId:       process.env.CASINO_AGENT_ID ?? 'cmoj1nya83zdnmhqizvk1hpbt',
    agentPassword,
    skinId:        process.env.CASINO_SKIN_ID ?? 'eeafa00307a1',
    skinDomain:    'admin.celuapuestas.bond',
    tenantId,
  };
}

// Punto de entrada de los routes: la fila del tenant primero; si no existe, cae a
// las env globales dejando el log FALLBACK-ENV (para monitorear qué tenants aún no
// migraron). Devuelve null solo si no hay ni fila ni env (→ "Casino no configurado").
export async function resolveCasinoCreds(tenantId: string): Promise<CasinoCreds | null> {
  const fromRow = await loadCasinoAccount(tenantId);
  if (fromRow) return fromRow;

  const fromEnv = envCasinoCreds(tenantId);
  if (fromEnv) {
    console.warn(`[casino] FALLBACK-ENV tenant=${tenantId} (sin fila en casino_accounts; usando credenciales globales de env)`);
    return fromEnv;
  }

  return null;
}
