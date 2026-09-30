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

import { testCasinoConnection, type CasinoTestFailReason } from '../client';
import type { CasinoProvider, ProviderContext, ProviderFailReason, ProviderTestResult } from './types';

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
};
