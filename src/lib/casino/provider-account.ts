// src/lib/casino/provider-account.ts
// Lectura y escritura GENÉRICAS de la conexión de casino de un tenant, para cualquier
// proveedor del registro (providers/index.ts).
//
// Aislamiento: todo sale de la fila default + activa de casino_accounts DEL tenant
// pedido. No hay fallback a env ni a la fila de otro tenant (fail-closed). Quien llama
// pasa el tenant de la sesión firmada (routes del panel) o el del path con requireAdmin
// (pantalla de admin); nunca un valor que mande el navegador para elegir cuenta.
//
// Dónde vive cada campo (lo declara el adaptador):
//   · field.column        → columna propia (solo celuapuestas; la fila de 17Star no cambia)
//   · no secreto, sin col → casino_accounts.config (jsonb)
//   · secreto, sin col    → dentro de casino_accounts.secrets_enc: UN blob AES-256-GCM
//                           con el JSON de los secretos (lib/secure-secret).
// Los secretos solo existen en claro dentro del route handler: publicState() expone
// apenas si están cargados (has_secrets), nunca su valor ni un fragmento.

import { supabaseAdmin } from '@/lib/db';
import { decryptSecret, encryptSecret } from '@/lib/secure-secret';
import { DEFAULT_PROVIDER_ID, getProvider } from './providers';
import type { CasinoProvider, LegacyColumn, ProviderContext } from './providers/types';

const LEGACY_COLUMNS: LegacyColumn[] = ['agent_username', 'agent_id', 'skin_id', 'skin_domain', 'api_base_url', 'agent_password_enc'];

export type ProviderAccountLoad =
  | { kind: 'none' }                                   // el tenant no tiene fila activa
  | { kind: 'ok'; provider: CasinoProvider; ctx: ProviderContext; row: any }
  | { kind: 'broken'; providerId: string; error: string };

export async function loadCasinoRow(tenantId: string): Promise<{ row: any | null; error: string | null }> {
  // select('*') a propósito: tolera que la migración de proveedores todavía no haya
  // corrido (sin provider → se asume celuapuestas, que es lo único que había).
  const { data, error } = await supabaseAdmin
    .from('casino_accounts').select('*')
    .eq('tenant_id', tenantId).eq('is_default', true).eq('active', true)
    .maybeSingle();
  return { row: data ?? null, error: error?.message ?? null };
}

export function providerIdOf(row: any): string {
  return (typeof row?.provider === 'string' && row.provider) ? row.provider : DEFAULT_PROVIDER_ID;
}

function decryptSecretsBlob(row: any): Record<string, string> {
  if (!row?.secrets_enc) return {};
  const parsed = JSON.parse(decryptSecret(row.secrets_enc));
  return parsed && typeof parsed === 'object' ? parsed : {};
}

/** Arma el ProviderContext de una fila. Lanza si un secreto no se puede descifrar. */
export function contextFromRow(provider: CasinoProvider, row: any): ProviderContext {
  const config = (row?.config && typeof row.config === 'object') ? row.config : {};
  const blob = decryptSecretsBlob(row);
  const values: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  for (const f of provider.fields) {
    if (f.kind === 'secret') {
      const v = f.column ? (row?.[f.column] ? decryptSecret(row[f.column]) : '') : (blob[f.key] ?? '');
      if (v) secrets[f.key] = v;
    } else {
      const raw = f.column ? row?.[f.column] : config[f.key];
      const v = typeof raw === 'string' ? raw.trim() : '';
      values[f.key] = v || f.defaultValue || '';
    }
  }
  // Columnas derivadas que el adaptador pueda necesitar (celuapuestas: skin_domain).
  if (row?.skin_domain && !values.skin_domain) values.skin_domain = String(row.skin_domain);
  return { accountId: String(row?.id ?? ''), tenantId: String(row?.tenant_id ?? ''), values, secrets };
}

/**
 * Conexión del tenant lista para operar. 'none' = sin casino configurado; 'broken' =
 * hay fila pero no se puede usar (proveedor desconocido, secreto faltante o
 * ilegible): el caller responde "casino no configurado" y NO cae a otra cuenta.
 */
export async function loadProviderAccount(tenantId: string): Promise<ProviderAccountLoad> {
  const { row, error } = await loadCasinoRow(tenantId);
  if (error) {
    console.error(`[casino] loadProviderAccount error tenant=${tenantId}:`, error);
    return { kind: 'broken', providerId: '?', error: 'No se pudo leer la configuración del casino.' };
  }
  if (!row) return { kind: 'none' };

  const providerId = providerIdOf(row);
  const provider = getProvider(providerId);
  if (!provider) {
    console.error(`[casino] proveedor desconocido "${providerId}" tenant=${tenantId}`);
    return { kind: 'broken', providerId, error: `Proveedor de casino desconocido: ${providerId}` };
  }

  let ctx: ProviderContext;
  try {
    ctx = contextFromRow(provider, row);
  } catch (err: any) {
    console.error(`[casino] no se pudo descifrar el secreto del casino tenant=${tenantId}:`, err?.message ?? err);
    return { kind: 'broken', providerId, error: 'Casino no configurado (secreto ilegible).' };
  }
  const missing = provider.fields.filter((f) => f.required && (f.kind === 'secret' ? !ctx.secrets[f.key] : !ctx.values[f.key]));
  if (missing.length) {
    return { kind: 'broken', providerId, error: `Casino no configurado: falta ${missing.map((f) => f.label).join(', ')}.` };
  }
  return { kind: 'ok', provider, ctx, row };
}

/**
 * Conexión de un proveedor del MODELO NUEVO, o null si el tenant usa celuapuestas
 * (o no tiene casino). Es la bifurcación de los routes: con null siguen por su código
 * de siempre, sin ningún cambio; si no, operan con el adaptador.
 */
export async function loadNonLegacyAccount(tenantId: string): Promise<Exclude<ProviderAccountLoad, { kind: 'none' }> | null> {
  const { row, error } = await loadCasinoRow(tenantId);
  // Ante un error de lectura NO se decide nada acá: el camino de siempre hace su
  // propia consulta y responde como hoy.
  if (error || !row) return null;
  const provider = getProvider(providerIdOf(row));
  if (provider?.legacyOperations) return null;
  const load = await loadProviderAccount(tenantId);
  return load.kind === 'none' ? null : load;
}

/**
 * Proveedor de la fila default del tenant (activa o no), o null si no tiene fila.
 * Lo usan los routes de configuración de celuapuestas para no pisar la fila de otro
 * proveedor. Ante un error de lectura devuelve UNREADABLE_PROVIDER, que no es un
 * proveedor del registro: isLegacyProviderId() da false y el route se niega a editar
 * (fail-closed) en vez de asumir celuapuestas.
 */
export const UNREADABLE_PROVIDER = '__unreadable__';

export async function getTenantProviderId(tenantId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from('casino_accounts').select('*')
    .eq('tenant_id', tenantId).eq('is_default', true)
    .maybeSingle();
  if (error) {
    console.error(`[casino] getTenantProviderId error tenant=${tenantId}:`, error.message);
    return UNREADABLE_PROVIDER;
  }
  if (!data) return null;
  return providerIdOf(data);
}

/**
 * Marca en casino_accounts.config: el admin activó el saldo del agente de una cuenta
 * con saldo OPCIONAL (provider.optionalAgentBalance) después de probarlo. Es lo que
 * decide 'casino' vs 'hybrid' (lib/casino/stock-mode). No es un campo del formulario:
 * buildProviderPatch la conserva y la borra sola si faltan los datos del saldo.
 */
export const AGENT_BALANCE_VERIFIED_KEY = 'agent_balance_verified_at';

/** ¿La cuenta da el saldo del agente? Sin base: sale del proveedor y del config. */
export function accountHasAgentBalance(provider: CasinoProvider, config: unknown): boolean {
  if (provider.hasAgentBalance) return true;
  if (!provider.optionalAgentBalance) return false;
  const c = (config && typeof config === 'object') ? config as Record<string, unknown> : {};
  return typeof c[AGENT_BALANCE_VERIFIED_KEY] === 'string' && !!c[AGENT_BALANCE_VERIFIED_KEY];
}

/**
 * Proveedor + config de la fila default del tenant, para el modo de stock. Mismas
 * reglas que getTenantProviderId (error → UNREADABLE_PROVIDER, sin fila → null).
 */
export async function getTenantProviderInfo(tenantId: string): Promise<{ providerId: string | null; config: Record<string, unknown> | null }> {
  const { data, error } = await supabaseAdmin
    .from('casino_accounts').select('*')
    .eq('tenant_id', tenantId).eq('is_default', true)
    .maybeSingle();
  if (error) {
    console.error(`[casino] getTenantProviderInfo error tenant=${tenantId}:`, error.message);
    return { providerId: UNREADABLE_PROVIDER, config: null };
  }
  if (!data) return { providerId: null, config: null };
  return { providerId: providerIdOf(data), config: (data.config && typeof data.config === 'object') ? data.config : null };
}

/** true si el proveedor corre por el código propio de los routes (celuapuestas). */
export function isLegacyProviderId(id: string | null): boolean {
  if (!id) return true;
  return !!getProvider(id)?.legacyOperations;
}

export const MANAGED_BY_ADMIN_MSG =
  'La conexión de este casino la administra IRIS. Para cambiarla, contactá al soporte de IRIS.';

// ── Estado público (para la UI; jamás incluye secretos) ──────────────────────

export function publicProviderState(row: any | null) {
  if (!row) return { has_row: false, provider: null, values: {}, has_secrets: {} };
  const provider = getProvider(providerIdOf(row));
  const config = (row.config && typeof row.config === 'object') ? row.config : {};
  let blobKeys: string[] = [];
  // Solo las CLAVES del blob, para mostrar "cargada ✓". Si no se puede descifrar se
  // muestra como no cargada (y la prueba de conexión lo va a decir).
  try { blobKeys = Object.keys(decryptSecretsBlob(row)); } catch { blobKeys = []; }
  const values: Record<string, string> = {};
  const has_secrets: Record<string, boolean> = {};
  for (const f of provider?.fields ?? []) {
    if (f.kind === 'secret') has_secrets[f.key] = f.column ? !!row[f.column] : blobKeys.includes(f.key);
    else values[f.key] = String((f.column ? row[f.column] : config[f.key]) ?? '');
  }
  return { has_row: true, provider: providerIdOf(row), values, has_secrets };
}

// ── Escritura ────────────────────────────────────────────────────────────────

export interface ProviderSaveInput {
  /** Valores tipeados. Un secreto vacío o ausente = no se cambia el guardado. */
  values: Record<string, unknown>;
  /**
   * Secretos OPCIONALES a borrar (keys de campos kind 'secret', required false y sin
   * columna propia). Es la única forma de vaciar un secreto: vacío = no se cambia.
   */
  clear?: string[];
}

/**
 * Arma el patch de casino_accounts para guardar `input` con `provider`, partiendo de
 * la fila actual (o null). Si cambia el proveedor se descartan config y secretos del
 * anterior (no quedan credenciales de otro casino mezcladas en la fila).
 * Devuelve connChanged = cambió algo que obliga a volver a probar la conexión, y
 * balanceChanged = cambió algún campo scope 'agent_balance' (solo el saldo del
 * agente: se prueba aparte y no apaga el casino). agentBalanceTurnedOff = la cuenta
 * tenía el saldo del agente activado y con este guardado le faltan los datos: la
 * marca se borra y el tenant vuelve a 'hybrid'.
 */
export function buildProviderPatch(
  provider: CasinoProvider,
  existing: any | null,
  input: ProviderSaveInput,
): { patch: Record<string, any>; connChanged: boolean; balanceChanged: boolean; agentBalanceTurnedOff: boolean; missing: string[] } {
  const providerChanged = !existing || providerIdOf(existing) !== provider.id;
  const oldConfig = (!providerChanged && existing?.config && typeof existing.config === 'object') ? existing.config : {};
  let oldBlob: Record<string, string> = {};
  if (!providerChanged) {
    try { oldBlob = decryptSecretsBlob(existing); } catch { oldBlob = {}; }
  }
  const clear = new Set(Array.isArray(input.clear) ? input.clear.filter((k) => typeof k === 'string') : []);

  const patch: Record<string, any> = { provider: provider.id };
  // Cambio de proveedor sobre una fila existente: se vacían las columnas propias que
  // el proveedor nuevo no usa (incluido el password cifrado del anterior).
  if (providerChanged && existing) {
    const used = new Set(provider.fields.map((f) => f.column).filter(Boolean));
    for (const col of LEGACY_COLUMNS) if (!used.has(col)) patch[col] = null;
  }
  const config: Record<string, string> = { ...oldConfig };
  const blob: Record<string, string> = { ...oldBlob };
  let connChanged = providerChanged;
  let balanceChanged = false;
  let blobChanged = providerChanged;
  // ¿Quedan cargados todos los datos propios del saldo (sin valor por defecto)?
  let balanceDataComplete = true;
  const missing: string[] = [];
  const flat: Record<string, string> = {};

  for (const f of provider.fields) {
    const raw = input.values[f.key];
    const typed = typeof raw === 'string' ? raw.trim() : '';
    const markChanged = () => { if (f.scope === 'agent_balance') balanceChanged = true; else connChanged = true; };

    if (f.kind === 'secret') {
      let current = '';
      try {
        current = f.column ? (existing?.[f.column] && !providerChanged ? decryptSecret(existing[f.column]) : '') : (oldBlob[f.key] ?? '');
      } catch { current = ''; }
      let final = current;
      if (typed && typed !== current) {
        markChanged();
        if (f.column) patch[f.column] = encryptSecret(typed);
        else { blob[f.key] = typed; blobChanged = true; }
        final = typed;
      } else if (!typed && clear.has(f.key) && !f.required && !f.column && current) {
        markChanged();
        delete blob[f.key];
        blobChanged = true;
        final = '';
      }
      if (f.required && !final) missing.push(f.label);
      if (f.scope === 'agent_balance' && !f.defaultValue && !final) balanceDataComplete = false;
      continue;
    }

    const prev = String((f.column ? (providerChanged ? '' : existing?.[f.column]) : oldConfig[f.key]) ?? '');
    const next = raw === undefined ? prev : typed;
    flat[f.key] = next;
    if (next !== prev) markChanged();
    if (f.column) patch[f.column] = next || null;
    else if (next) config[f.key] = next;
    else delete config[f.key];
    if (f.required && !next) missing.push(f.label);
    if (f.scope === 'agent_balance' && !f.defaultValue && !next) balanceDataComplete = false;
  }

  // Sin los datos del saldo, la marca de "saldo activado" no puede quedar: el tenant
  // vuelve a 'hybrid' (el caller lo registra con el valor del pozo).
  const hadAgentBalance = !!oldConfig[AGENT_BALANCE_VERIFIED_KEY];
  const agentBalanceTurnedOff = hadAgentBalance && !balanceDataComplete;
  if (!balanceDataComplete) delete config[AGENT_BALANCE_VERIFIED_KEY];

  if (provider.deriveColumns) Object.assign(patch, provider.deriveColumns(flat));
  patch.config = config;
  if (blobChanged) patch.secrets_enc = Object.keys(blob).length ? encryptSecret(JSON.stringify(blob)) : null;
  return { patch, connChanged, balanceChanged, agentBalanceTurnedOff, missing };
}
