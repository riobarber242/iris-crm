// src/lib/casino/verify-carga.ts
// Verificar una CARGA de un proveedor del MODELO NUEVO: primero el casino, después
// la caja. Lo llama PATCH /api/comprobantes (verificar) cuando la carga es de un
// tenant con el casino activado y un proveedor de providers/ (no celuapuestas, que
// sigue por su camino de siempre: caja primero, depósito después).
//
// Orden y por qué:
//   1. Control de stock ANTES del casino (solo modo 'hybrid' con la caja activada):
//      si el pozo no alcanza para monto + bono, no se acredita nada.
//   2. Depósito con la protección de siempre (deposit-guard): reserva atómica +
//      reconciliación por saldo. Antes de depositar se guardan monto y bono en el
//      comprobante: quedan fijos, y cualquier reintento usa lo que se acreditó.
//        rechazado        → no se movió nada; pendiente con el motivo.
//        en curso/revisar → no se mueve la caja; aviso de siempre.
//   3. Solo con el depósito confirmado se mueve la caja (aplicarCargaComprobante,
//      la misma función de siempre). Después el route verifica como siempre.
//   4. Caso raro: el casino acreditó pero la caja falló (otro operador vació el pozo
//      entre el control y el movimiento, error de base, la función se cortó). NO se
//      revierte el casino: el comprobante queda pendiente con casino_deposited_at, se
//      registra y se avisa. Se corrige tocando Verificar de nuevo: el depósito ya
//      figura hecho (no se vuelve a acreditar) y la caja no se cobra dos veces (un
//      comprobante = un movimiento). Mismo camino que después de "Sí, entró".

import { supabaseAdmin } from '@/lib/db';
import { logActivity, ACTIVITY } from '@/lib/activity-log';
import { aplicarCargaComprobante, hayStockParaCarga, isCajaEnabled } from '@/lib/caja';
import { broadcastComprobanteChange } from '@/lib/realtime-broadcast';
import type { SessionPayload } from '@/lib/session';
import { guardedDeposit } from './deposit-guard';
import type { ProviderAccountLoad } from './provider-account';
import type { CasinoStockMode } from './stock-mode';

export type VerifyCargaResult =
  | { ok: true; depositedAt: string | null }
  | { ok: false; status: number; message: string };

/** Dependencias inyectables (en prod, las reales; en la prueba offline, falsas). */
export interface VerifyCargaDeps {
  db: Pick<typeof supabaseAdmin, 'from'>;
  guardedDeposit: typeof guardedDeposit;
  aplicarCargaComprobante: typeof aplicarCargaComprobante;
  hayStockParaCarga: typeof hayStockParaCarga;
  isCajaEnabled: typeof isCajaEnabled;
  logActivity: typeof logActivity;
  broadcast: (tenantId: string) => Promise<unknown>;
}

const DEFAULT_DEPS: VerifyCargaDeps = {
  db: supabaseAdmin,
  guardedDeposit,
  aplicarCargaComprobante,
  hayStockParaCarga,
  isCajaEnabled,
  logActivity,
  broadcast: broadcastComprobanteChange,
};

export const CAJA_PENDIENTE_MSG =
  'Corregí lo que falte (por ejemplo, cargá fichas al pozo en Fichas) y tocá Verificar de nuevo: ' +
  'no se vuelve a acreditar en el casino.';

export async function verifyCargaWithProvider(
  p: {
    session: SessionPayload;
    comprobante: any;              // fila de comprobantes (select *)
    comprobanteId: string;
    monto: number;                 // monto efectivo de esta verificación
    bono: number | null;           // bono efectivo (ya normalizado)
    stockMode: CasinoStockMode;
    account: Exclude<ProviderAccountLoad, { kind: 'none' }>;
  },
  deps: VerifyCargaDeps = DEFAULT_DEPS,
): Promise<VerifyCargaResult> {
  const { session, comprobante, comprobanteId, stockMode, account } = p;
  const tenantId = session.tenant_id;

  if (account.kind === 'broken') {
    return { ok: false, status: 400, message: `${account.error} La recarga NO se verificó.` };
  }
  const { provider, ctx } = account;

  const montoCasino = Number(p.monto ?? 0);
  const bonoCasino  = Number(p.bono) || 0;
  const montoTotal  = montoCasino + bonoCasino;
  const needsDeposit = !comprobante.casino_deposited_at && montoCasino > 0;
  let depositedAt: string | null = null;

  if (needsDeposit) {
    const { data: ct } = await deps.db
      .from('contacts').select('name, casino_username')
      .eq('id', comprobante.contact_id).eq('tenant_id', tenantId).maybeSingle();
    const username = String(ct?.casino_username ?? ct?.name ?? '').trim();
    if (!username) {
      return { ok: false, status: 400, message: 'El contacto no tiene nombre para acreditar en el casino.' };
    }

    // 1. Stock antes del casino (solo cuando esta carga va a descontar del pozo).
    if (stockMode === 'hybrid' && await deps.isCajaEnabled(session)) {
      const st = await deps.hayStockParaCarga(session, { comprobanteId, monto: montoCasino, bono: bonoCasino });
      if (!st.ok) {
        const msg = st.error
          ? `No se pudo leer el pozo de fichas (${st.error}).`
          : `No hay fichas suficientes en el pozo: hay ${st.disponible.toLocaleString('es-AR')} y esta carga necesita ${st.necesario.toLocaleString('es-AR')} (monto + bono). Cargá fichas en Fichas.`;
        return { ok: false, status: 400, message: `${msg} La recarga NO se verificó y no se acreditó en el casino.` };
      }
    }

    // Monto y bono quedan fijos ANTES de depositar: si esta verificación no termina
    // (caja que falla, "a revisar"), el reintento usa exactamente lo que se acreditó.
    // Solo si nadie está depositando (sin estado): una carga en curso o a revisar
    // conserva el monto que se intentó; la reserva de abajo la frena igual.
    const { error: fixErr } = await deps.db
      .from('comprobantes').update({ monto: montoCasino, bono: p.bono ?? null })
      .eq('id', comprobanteId).eq('tenant_id', tenantId)
      .is('casino_deposited_at', null).is('casino_deposit_state', null);
    if (fixErr) {
      return { ok: false, status: 500, message: `No se pudo preparar la carga (${fixErr.message}). La recarga NO se verificó.` };
    }

    // 2. Depósito.
    const dep = await deps.guardedDeposit({ provider, ctx, tenantId, comprobanteId, username, amount: montoTotal });
    if (!dep.success) {
      await deps.logActivity({
        session, action: ACTIVITY.CASINO_DEPOSIT, objectType: 'comprobante', objectId: comprobanteId,
        details: {
          ok: false, provider: provider.id, reason: dep.reason, state: dep.state, detail: dep.detail ?? dep.error,
          username, amount: montoTotal, monto: montoCasino, bono: bonoCasino, caja: 'sin mover',
        },
      });
      await deps.broadcast(tenantId).catch(() => {});
      return dep.state === 'released'
        ? { ok: false, status: 400, message: `${dep.error} La recarga NO se verificó.` }
        : { ok: false, status: 409, message: dep.error };
    }
    depositedAt = dep.depositedAt;
    await deps.logActivity({
      session, action: ACTIVITY.CASINO_DEPOSIT, objectType: 'comprobante', objectId: comprobanteId,
      details: { ok: true, provider: provider.id, reconciled: dep.reconciled, username, amount: montoTotal, monto: montoCasino, bono: bonoCasino },
    });
  }

  // 3. Caja, solo con el depósito confirmado (o ya hecho antes).
  const mov = await deps.aplicarCargaComprobante(session, {
    comprobanteId,
    tipo:  comprobante.tipo,
    monto: montoCasino,
    bono:  p.bono,
    casinoEnabled: stockMode === 'casino',
  });
  if (mov.ok) return { ok: true, depositedAt };

  const acreditada = !!(depositedAt || comprobante.casino_deposited_at);
  if (!acreditada) {
    // Sin casino de por medio (monto 0): igual que la caja manual.
    return { ok: false, status: 400, message: mov.error };
  }

  // 4. Acreditada en el casino, caja sin registrar. No se revierte el casino.
  console.error(
    `[verify-carga] ACREDITADA en el casino pero la caja falló tenant=${tenantId} comprobante=${comprobanteId} ` +
    `provider=${provider.id} monto=${montoCasino} bono=${bonoCasino}: ${mov.error}`,
  );
  await deps.logActivity({
    session, action: ACTIVITY.CASINO_DEPOSIT, objectType: 'comprobante', objectId: comprobanteId,
    details: {
      ok: true, provider: provider.id, caja_failed: true, caja_error: mov.error,
      amount: montoTotal, monto: montoCasino, bono: bonoCasino,
    },
  });
  await deps.broadcast(tenantId).catch(() => {});
  return {
    ok: false, status: 409,
    message: `La carga SE ACREDITÓ en el casino, pero no se pudo registrar la caja: ${mov.error}. ${CAJA_PENDIENTE_MSG}`,
  };
}
