// src/lib/casino/deposit-guard.ts
// Depósito al jugador SIN duplicados, para cualquier proveedor del modelo nuevo.
//
// El problema: las APIs de casino como agentes.plus no tienen ID de operación, así que
// un deposit repetido acredita dos veces. Y "repetido" pasa solo: doble click, dos
// operadores sobre el mismo comprobante, o un timeout que el operador reintenta
// cuando en realidad el casino sí lo procesó.
//
// La solución, en capas:
//   1. RESERVA ATÓMICA. Antes de llamar al casino, un UPDATE condicional pasa el
//      comprobante a casino_deposit_state='in_flight' solo si no está acreditado ni
//      en curso. Un único pedido gana; el resto recibe "ya se está acreditando".
//      (Mismo patrón que el arreglo de delivered_count: la base decide, no el código.)
//   2. SALDO ANTES. Se lee el saldo del jugador (B0). Si esto falla todavía no se
//      tocó plata: se libera la reserva y se muestra el motivo.
//   3. DEPÓSITO, que el adaptador clasifica como:
//        ok          → se marca acreditado en el acto (casino_deposited_at + 'done');
//        not_applied → el casino dijo que no: se libera la reserva (reintentar es seguro);
//        ambiguous   → timeout / 5xx / red: NO se reintenta. Se reconcilia (paso 4).
//   4. RECONCILIACIÓN. Se relee el saldo:
//        B1 = B0 + monto          → entró: acreditado;
//        cualquier otra cosa      → 'unknown': se bloquea y se resuelve A MANO mirando
//                                   el panel del casino. Nunca se libera sola, ni
//                                   siquiera con el saldo sin cambios (el casino pudo
//                                   procesarlo tarde) ni si se movió por otra cosa (el
//                                   jugador pudo estar jugando).
//   5. Si la función muere en el medio (maxDuration de Vercel), la fila queda
//      'in_flight'; pasados STALE_MS se trata como 'unknown', nunca como libre.
//
// Nunca se reintenta un depósito salvo el 429 (el adaptador ya lo hizo: el casino lo
// rechazó sin procesarlo).

import { supabaseAdmin } from '@/lib/db';
import type { CasinoProvider, ProviderContext, ProviderFailReason } from './providers/types';

/** Cliente de base inyectable (en prod, supabaseAdmin; en la prueba offline, uno falso). */
type Db = Pick<typeof supabaseAdmin, 'from'>;

/** Un 'in_flight' más viejo que esto se considera trabado → 'unknown'. */
export const STALE_MS = 2 * 60_000;

// Presupuesto total del flujo. El route de comprobantes tiene maxDuration = 60.
const BUDGET_MS = 50_000;
// Lo que tiene que quedar antes del depósito para poder además reconciliar. Si no
// queda, se cancela ANTES de mover plata (seguro de reintentar).
const MIN_BEFORE_DEPOSIT_MS = 30_000;
const RECONCILE_WAIT_MS = 3_000;
const RECONCILE_READ_TIMEOUT_MS = 6_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const same = (a: number, b: number) => Math.abs(a - b) < 0.005;

export const UNKNOWN_DEPOSIT_MSG =
  'No se pudo confirmar si la carga entró en el casino. Quedó bloqueada para no acreditarla dos veces: ' +
  'revisá en el panel del casino (operaciones API) si entró y marcalo en IRIS.';

export type GuardedDepositResult =
  | { success: true; depositedAt: string; reconciled: boolean; ref: Record<string, unknown> }
  | {
      success: false;
      /** 'unknown' = quedó bloqueado a revisión manual; lo demás es seguro de reintentar. */
      state: 'released' | 'in_flight' | 'unknown';
      reason: ProviderFailReason | 'in_progress' | 'needs_review' | 'no_budget' | 'db_error';
      error: string;
      detail?: string;
    };

interface GuardParams {
  provider: CasinoProvider;
  ctx: ProviderContext;
  tenantId: string;
  comprobanteId: string;
  username: string;
  amount: number;
}

function isMissingColumn(msg: string | undefined): boolean {
  return !!msg && /casino_deposit_state|casino_deposit_started_at|column|schema cache/i.test(msg);
}

async function release(db: Db, tenantId: string, comprobanteId: string) {
  const { error } = await db
    .from('comprobantes')
    .update({ casino_deposit_state: null, casino_deposit_started_at: null })
    .eq('id', comprobanteId).eq('tenant_id', tenantId).eq('casino_deposit_state', 'in_flight');
  if (error) console.error(`[casino-guard] no se pudo liberar comprobante=${comprobanteId}:`, error.message);
}

async function markUnknown(db: Db, tenantId: string, comprobanteId: string, ref: Record<string, unknown>) {
  const { error } = await db
    .from('comprobantes')
    .update({ casino_deposit_state: 'unknown', casino_deposit_ref: JSON.stringify(ref) })
    .eq('id', comprobanteId).eq('tenant_id', tenantId).eq('casino_deposit_state', 'in_flight');
  // Si esto falla la fila queda 'in_flight' y a los STALE_MS pasa a 'unknown' igual.
  if (error) console.error(`[casino-guard] no se pudo marcar unknown comprobante=${comprobanteId}:`, error.message);
}

async function markDone(db: Db, tenantId: string, comprobanteId: string, ref: Record<string, unknown>): Promise<string> {
  const at = new Date().toISOString();
  const { error } = await db
    .from('comprobantes')
    .update({ casino_deposited_at: at, casino_deposit_state: 'done', casino_deposit_ref: JSON.stringify(ref) })
    .eq('id', comprobanteId).eq('tenant_id', tenantId).eq('casino_deposit_state', 'in_flight');
  // La plata YA entró. Si la marca falla, el route igual escribe casino_deposited_at
  // en su update final; y si eso también fallara, la fila queda 'in_flight' → a los
  // STALE_MS pasa a revisión manual, nunca a "libre para reintentar".
  if (error) console.error(`[casino-guard] depósito OK pero no se pudo marcar comprobante=${comprobanteId}:`, error.message);
  return at;
}

/**
 * Paso 1. Reserva el comprobante. Si otro pedido lo tiene, explica por qué no se
 * puede seguir (y convierte un 'in_flight' trabado en 'unknown').
 */
async function claim(db: Db, tenantId: string, comprobanteId: string): Promise<GuardedDepositResult | null> {
  const { data, error } = await db
    .from('comprobantes')
    .update({ casino_deposit_state: 'in_flight', casino_deposit_started_at: new Date().toISOString() })
    .eq('id', comprobanteId).eq('tenant_id', tenantId)
    .is('casino_deposited_at', null).is('casino_deposit_state', null)
    .select('id');

  if (error) {
    // Fail-closed: sin la columna no hay reserva, y sin reserva no se deposita.
    const detail = error.message;
    return {
      success: false, state: 'released', reason: 'db_error', detail,
      error: isMissingColumn(detail)
        ? 'Falta correr la migración de proveedores de casino. La carga NO se acreditó.'
        : 'No se pudo reservar la carga para acreditarla. La carga NO se acreditó.',
    };
  }
  if (data && data.length === 1) return null;   // reservado: seguir

  const { data: cur } = await db
    .from('comprobantes').select('casino_deposited_at, casino_deposit_state, casino_deposit_started_at')
    .eq('id', comprobanteId).eq('tenant_id', tenantId).maybeSingle();

  if (cur?.casino_deposited_at) {
    return { success: true, depositedAt: cur.casino_deposited_at, reconciled: false, ref: { already: true } };
  }
  if (cur?.casino_deposit_state === 'in_flight') {
    const started = cur.casino_deposit_started_at ? Date.parse(cur.casino_deposit_started_at) : 0;
    if (Date.now() - started > STALE_MS) {
      await db
        .from('comprobantes').update({ casino_deposit_state: 'unknown' })
        .eq('id', comprobanteId).eq('tenant_id', tenantId).eq('casino_deposit_state', 'in_flight');
      return { success: false, state: 'unknown', reason: 'needs_review', error: UNKNOWN_DEPOSIT_MSG };
    }
    return {
      success: false, state: 'in_flight', reason: 'in_progress',
      error: 'Esta carga ya se está acreditando en el casino. Esperá unos segundos y actualizá.',
    };
  }
  if (cur?.casino_deposit_state === 'unknown') {
    return { success: false, state: 'unknown', reason: 'needs_review', error: UNKNOWN_DEPOSIT_MSG };
  }
  return { success: false, state: 'released', reason: 'db_error', error: 'Comprobante no encontrado.' };
}

export async function guardedDeposit(p: GuardParams, db: Db = supabaseAdmin): Promise<GuardedDepositResult> {
  const { provider, ctx, tenantId, comprobanteId, username, amount } = p;
  if (!provider.deposit || !provider.playerBalance) {
    return { success: false, state: 'released', reason: 'invalid', error: `El proveedor ${provider.label} no soporta depósitos.` };
  }
  const deadlineAt = Date.now() + BUDGET_MS;

  const blocked = await claim(db, tenantId, comprobanteId);
  if (blocked) return blocked;

  // Paso 2: saldo antes. Todavía no se movió plata → cualquier falla libera.
  const before = await provider.playerBalance(ctx, username, { deadlineAt: deadlineAt - MIN_BEFORE_DEPOSIT_MS });
  if (!before.ok) {
    await release(db, tenantId, comprobanteId);
    return { success: false, state: 'released', reason: before.reason, error: `${before.error} La carga NO se acreditó.`, detail: before.detail };
  }
  const b0 = before.balance;

  if (deadlineAt - Date.now() < MIN_BEFORE_DEPOSIT_MS) {
    await release(db, tenantId, comprobanteId);
    return {
      success: false, state: 'released', reason: 'no_budget',
      error: 'El casino está respondiendo muy lento. La carga NO se acreditó — reintentá en un minuto.',
    };
  }

  // Paso 3: el depósito. Se le deja lo justo para poder reconciliar después.
  const depositDeadline = deadlineAt - (2 * (RECONCILE_WAIT_MS + RECONCILE_READ_TIMEOUT_MS));
  const r = await provider.deposit(ctx, username, amount, depositDeadline);
  const baseRef = { provider: provider.id, username, amount, b0 };

  if (r.kind === 'ok') {
    const depositedAt = await markDone(db, tenantId, comprobanteId, { ...baseRef, result: 'ok' });
    return { success: true, depositedAt, reconciled: false, ref: { ...baseRef, result: 'ok' } };
  }
  if (r.kind === 'not_applied') {
    await release(db, tenantId, comprobanteId);
    return { success: false, state: 'released', reason: r.reason, error: `${r.error} La carga NO se acreditó.`, detail: r.detail };
  }

  // Paso 4: ambiguo → reconciliar por saldo, sin reintentar el depósito.
  console.warn(`[casino-guard] depósito ambiguo comprobante=${comprobanteId} ${r.detail ?? ''} — reconciliando por saldo`);
  const reads: number[] = [];
  for (let i = 0; i < 2; i++) {
    await sleep(RECONCILE_WAIT_MS);
    const after = await provider.playerBalance(ctx, username, { timeoutMs: RECONCILE_READ_TIMEOUT_MS, retry: false });
    if (!after.ok) break;
    reads.push(after.balance);
    if (same(after.balance, b0 + amount)) {
      const ref = { ...baseRef, result: 'reconciled_ok', reads, ambiguous: r.detail };
      const depositedAt = await markDone(db, tenantId, comprobanteId, ref);
      return { success: true, depositedAt, reconciled: true, ref };
    }
    if (!same(after.balance, b0)) break;          // se movió por otra cosa → manual
  }

  // Saldo sin cambios en las dos lecturas: casi seguro NO entró, pero un casino puede
  // procesar tarde un pedido que ya recibió. Liberar solo arriesga el doble crédito,
  // así que también va a revisión manual (cuesta un click), con la pista en el texto.
  const unchanged = reads.length === 2 && reads.every((b) => same(b, b0));
  await markUnknown(db, tenantId, comprobanteId, {
    ...baseRef, result: unchanged ? 'unknown_balance_unchanged' : 'unknown', reads, ambiguous: r.detail,
  });
  return {
    success: false, state: 'unknown', reason: 'needs_review', detail: r.detail,
    error: unchanged
      ? `${r.error} El saldo del jugador no cambió, así que probablemente NO entró, pero quedó bloqueada ` +
        'para no acreditarla dos veces: confirmalo en el panel del casino (operaciones API) y marcalo en IRIS.'
      : `${r.error} ${UNKNOWN_DEPOSIT_MSG}`,
  };
}

/**
 * Interruptor por tenant `casino_deposit_guard` (tabla settings, value 'true').
 * Lleva a esta protección a los proveedores que operan por su código propio
 * (celuapuestas / 17Star). Apagado por defecto: sin fila, con otro valor o si la
 * lectura falla, sigue el camino de siempre. Se prende/apaga sin redeploy.
 */
export const DEPOSIT_GUARD_KEY = 'casino_deposit_guard';

export async function isDepositGuardEnabled(tenantId: string, db: Db = supabaseAdmin): Promise<boolean> {
  try {
    const { data, error } = await db
      .from('settings').select('value')
      .eq('key', DEPOSIT_GUARD_KEY).eq('tenant_id', tenantId).maybeSingle();
    if (error) {
      console.warn(`[casino-guard] no se pudo leer ${DEPOSIT_GUARD_KEY} tenant=${tenantId} (queda apagado):`, error.message);
      return false;
    }
    return data?.value === 'true';
  } catch {
    return false;
  }
}

/**
 * Camino de siempre (celuapuestas sin el interruptor): mensaje para NO depositar si
 * la carga quedó reservada o a revisar por el flujo protegido; null = puede seguir.
 * Pura, para la prueba offline.
 */
export function legacyDepositBlock(row: {
  casino_deposited_at?: string | null;
  casino_deposit_state?: string | null;
  casino_deposit_started_at?: string | null;
}): string | null {
  if (row.casino_deposited_at) return null;
  if (row.casino_deposit_state === 'unknown') return UNKNOWN_DEPOSIT_MSG;
  if (row.casino_deposit_state === 'in_flight') {
    return isStaleInFlight(row)
      ? UNKNOWN_DEPOSIT_MSG
      : 'Esta carga ya se está acreditando en el casino. Esperá unos segundos y actualizá.';
  }
  return null;
}

/** El 'in_flight' de este comprobante está trabado (la función murió en el medio). */
export function isStaleInFlight(row: { casino_deposit_state?: string | null; casino_deposit_started_at?: string | null }): boolean {
  if (row.casino_deposit_state !== 'in_flight') return false;
  const started = row.casino_deposit_started_at ? Date.parse(row.casino_deposit_started_at) : 0;
  return Date.now() - started > STALE_MS;
}
