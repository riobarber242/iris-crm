import axios from 'axios';
import { supabaseAdmin } from '../db';
import { logActivity, ACTIVITY } from '../activity-log';
import type { SessionPayload } from '../session';

// ─────────────────────────────────────────────────────────────────────────────
// Integración con el casino (celuapuestas): al verificar una CARGA en Iris,
// acreditar el monto al player vía el endpoint DoDeposit (framework ABP).
//
// Credenciales por env (v1, solo tenant Casino 17Star):
//   CASINO_API_TOKEN    — System User JWT del agente, con permiso para depositar.
//   CASINO_API_BASE_URL — base del casino (default https://admin.celuapuestas.bond).
//
// Reglas de negocio fijadas: 1 ficha = 1 peso ARS (amount = monto tal cual);
// username del player = contacts.name; si DoDeposit falla NO se verifica y NO se
// reintenta automáticamente.
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_BASE_URL = 'https://admin.celuapuestas.bond';
const FLAG_KEY = 'casino_deposit_enabled';

function getBaseUrl(): string {
  return (process.env.CASINO_API_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

export type DoDepositResult =
  | { ok: true; ref: string | null }
  | { ok: false; error: string };

// Llama al endpoint DoDeposit. OJO: ABP devuelve HTTP 500 con success:false en
// errores de negocio (ej. "Entidad no encontrada"), así que la fuente de verdad
// es body.success, NO el status HTTP.
export async function doDeposit(username: string, amount: number): Promise<DoDepositResult> {
  const token = process.env.CASINO_API_TOKEN;
  if (!token) return { ok: false, error: 'CASINO_API_TOKEN no configurado' };

  const user = String(username ?? '').trim();
  if (!user) return { ok: false, error: 'Falta el nombre del player' };

  const monto = Math.trunc(Number(amount));
  if (!Number.isFinite(monto) || monto <= 0) return { ok: false, error: 'Monto inválido' };

  try {
    const res = await axios.post(
      `${getBaseUrl()}/api/services/app/Players/DoDeposit`,
      { username: user, amount: monto },
      {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        timeout: 15000,
        validateStatus: () => true, // parseamos el envelope ABP, no el status HTTP
      },
    );

    const data: any = res.data;
    const isObj = data !== null && typeof data === 'object';

    // ÉXITO: el casino devuelve HTTP 200 con un body HTML (string), NO el envelope
    // JSON de error. Tratamos 200 como éxito salvo que venga un fallo EXPLÍCITO
    // (envelope ABP con success:false o unAuthorizedRequest). Los errores reales
    // (ej. "Entidad no encontrada") llegan con HTTP 500 + success:false.
    const fallaExplicita = isObj && (data.success === false || data.unAuthorizedRequest === true);
    if (res.status === 200 && !fallaExplicita) {
      const ref = isObj ? (data.result?.id ?? data.result?.transactionId ?? null) : null;
      return { ok: true, ref: ref != null ? String(ref) : null };
    }

    if (isObj && data.unAuthorizedRequest) {
      return { ok: false, error: 'El token del casino no está autorizado (revisá CASINO_API_TOKEN).' };
    }
    // data.error puede ser string ("Entidad no encontrada") u objeto {message,...}.
    const err = isObj
      ? (data.error?.message ?? data.error ?? `Respuesta inesperada del casino (HTTP ${res.status})`)
      : `Respuesta inesperada del casino (HTTP ${res.status})`;
    return { ok: false, error: String(err) };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Error de red al acreditar en el casino' };
  }
}

// Flag por tenant. Default OFF (sin fila, error o value != 'true' → false).
export async function isCasinoDepositEnabled(tenantId: string): Promise<boolean> {
  try {
    const { data, error } = await supabaseAdmin
      .from('settings').select('value')
      .eq('key', FLAG_KEY).eq('tenant_id', tenantId).maybeSingle();
    if (error) return false;
    return data?.value === 'true';
  } catch {
    return false;
  }
}

export type CasinoDepositResult =
  | { ok: true; applied: boolean; ref?: string | null; depositedAt?: string }
  | { ok: false; error: string };

// Orquesta el depósito al verificar una CARGA: flag → idempotencia → username →
// llamada. `applied:false` con `ok:true` significa "no correspondía depositar"
// (flag off, no es carga, ya depositado o monto<=0): el caller verifica normal.
// `ok:false` es un fallo real: el caller NO debe verificar.
export async function applyCasinoDeposit(
  session: SessionPayload,
  comprobante: { id: string; tipo?: string | null; contact_id?: string | null; casino_deposited_at?: string | null },
  monto: number,
): Promise<CasinoDepositResult> {
  if (!(await isCasinoDepositEnabled(session.tenant_id))) return { ok: true, applied: false };
  if ((comprobante.tipo ?? 'carga') !== 'carga') return { ok: true, applied: false };
  // Idempotencia: un comprobante se acredita en el casino UNA sola vez.
  if (comprobante.casino_deposited_at) return { ok: true, applied: false };

  const amount = Math.trunc(Number(monto));
  if (!Number.isFinite(amount) || amount <= 0) return { ok: true, applied: false };

  if (!comprobante.contact_id) {
    return { ok: false, error: 'El comprobante no tiene contacto para acreditar en el casino.' };
  }

  const { data: contact } = await supabaseAdmin
    .from('contacts').select('name')
    .eq('id', comprobante.contact_id).eq('tenant_id', session.tenant_id).maybeSingle();
  const username = String(contact?.name ?? '').trim();
  if (!username) {
    return { ok: false, error: 'El contacto no tiene nombre cargado para usar como usuario del casino.' };
  }

  const dep = await doDeposit(username, amount);
  if (!dep.ok) {
    await logActivity({
      session, action: ACTIVITY.CASINO_DEPOSIT, objectType: 'comprobante', objectId: comprobante.id,
      details: { ok: false, username, amount, error: dep.error },
    });
    return { ok: false, error: `No se pudo acreditar en el casino: ${dep.error} La recarga NO se verificó.` };
  }

  await logActivity({
    session, action: ACTIVITY.CASINO_DEPOSIT, objectType: 'comprobante', objectId: comprobante.id,
    details: { ok: true, username, amount, ref: dep.ref },
  });
  return { ok: true, applied: true, ref: dep.ref, depositedAt: new Date().toISOString() };
}
