import { supabaseAdmin } from './db';
import { logActivity, ACTIVITY } from './activity-log';
import type { SessionPayload } from './session';

// ─────────────────────────────────────────────────────────────────────────────
// Caja de fichas y billeteras por operador (Etapa 2: lógica, sin enganchar).
//
// La atomicidad vive en Postgres: estas funciones son wrappers finos sobre las
// funciones plpgsql fn_aplicar_movimiento / fn_recargar_fichas (ver
// supabase-caja-fichas.sql), que corren cada una en UNA transacción con el
// guard de stock negativo infalible. Acá solo calculamos los deltas, validamos
// rol/monto, llamamos la RPC y registramos en activity_log.
//
// NADA de esto se llama todavía desde el flujo de verificar comprobantes; eso
// es Etapa 3. Si las tablas/funciones aún no existen, degradamos con elegancia
// (mismo patrón que el campo bono): devolvemos { ok:false, degraded:true } sin
// tirar excepción, para no romper a quien nos llame.
// ─────────────────────────────────────────────────────────────────────────────

export type MovimientoTipo = 'carga' | 'pago' | 'descarga' | 'sueldo' | 'traspaso';
export type TraspasoLado   = 'origen' | 'destino';

export type Deltas = { fichas_delta: number; billetera_delta: number };

// Tabla central de deltas. Única fuente de verdad de cómo cada tipo de
// movimiento afecta al pozo de fichas y a la billetera del operador.
//   carga:    fichas -(monto+bono),  billetera +monto
//   pago:     fichas +monto,          billetera -monto
//   descarga: fichas 0,               billetera -monto
//   sueldo:   fichas 0,               billetera -monto
//   traspaso(origen):  fichas 0,      billetera -monto
//   traspaso(destino): fichas 0,      billetera +monto
export function computeDeltas(
  tipo: MovimientoTipo,
  monto: number,
  bono: number = 0,
  lado?: TraspasoLado,
): Deltas {
  switch (tipo) {
    case 'carga':    return { fichas_delta: -(monto + bono), billetera_delta:  monto };
    case 'pago':     return { fichas_delta:  monto,          billetera_delta: -monto };
    case 'descarga': return { fichas_delta:  0,              billetera_delta: -monto };
    case 'sueldo':   return { fichas_delta:  0,              billetera_delta: -monto };
    case 'traspaso':
      return lado === 'destino'
        ? { fichas_delta: 0, billetera_delta:  monto }
        : { fichas_delta: 0, billetera_delta: -monto }; // 'origen' por defecto
    default: {
      // Exhaustividad: si se agrega un tipo nuevo, TypeScript marca acá.
      const _never: never = tipo;
      throw new Error(`Tipo de movimiento desconocido: ${String(_never)}`);
    }
  }
}

export type CajaResult =
  | { ok: true;  movimientoId: string; stock: number; saldo: number }
  | { ok: false; error: string; degraded?: boolean };

export type RecargaResult =
  | { ok: true;  stock: number }
  | { ok: false; error: string; degraded?: boolean };

export type AplicarMovimientoParams = {
  operadorId:     string;
  tipo:           MovimientoTipo;
  monto:          number;
  bono?:          number | null;
  comprobanteId?: string | null;
  contraparteId?: string | null;  // el otro operador, en traspasos
  lado?:          TraspasoLado;    // solo relevante para 'traspaso'
};

// Detecta que la migración supabase-caja-fichas.sql aún no se corrió (tabla o
// función ausente) para degradar en vez de romper.
//   42P01 = relación inexistente · 42883 = función inexistente · PGRST202 = RPC no hallada
function isMissingCajaError(err: any): boolean {
  if (!err) return false;
  const code = String(err.code ?? '');
  const msg  = String(err.message ?? '');
  if (code === '42P01' || code === '42883' || code === 'PGRST202') return true;
  return /fichas_stock|operador_billetera|movimientos|fn_aplicar_movimiento|fn_recargar_fichas|schema cache|does not exist|could not find/i.test(msg);
}

// Aplica un movimiento de caja de forma atómica. Calcula los deltas y delega la
// escritura (pozo + billetera + movimientos) a fn_aplicar_movimiento, que aborta
// si el pozo quedaría negativo ("No hay fichas suficientes").
export async function aplicarMovimiento(
  session: SessionPayload,
  p: AplicarMovimientoParams,
): Promise<CajaResult> {
  const monto = Math.trunc(Number(p.monto));
  if (!Number.isFinite(monto) || monto <= 0) {
    return { ok: false, error: 'Monto inválido' };
  }
  const bono = p.bono != null && Number(p.bono) > 0 ? Math.trunc(Number(p.bono)) : 0;
  const { fichas_delta, billetera_delta } = computeDeltas(p.tipo, monto, bono, p.lado);

  try {
    const { data, error } = await supabaseAdmin.rpc('fn_aplicar_movimiento', {
      p_tenant:          session.tenant_id,
      p_operador:        p.operadorId,
      p_tipo:            p.tipo,
      p_monto:           monto,
      p_bono:            bono > 0 ? bono : null,
      p_fichas_delta:    fichas_delta,
      p_billetera_delta: billetera_delta,
      p_comprobante:     p.comprobanteId ?? null,
      p_contraparte:     p.contraparteId ?? null,
      p_creado_por:      session.sub,
      p_creado_por_name: session.name,
    });

    if (error) {
      if (isMissingCajaError(error)) return { ok: false, error: 'Caja no inicializada', degraded: true };
      // Errores de negocio de la función (ej: "No hay fichas suficientes").
      return { ok: false, error: error.message };
    }

    const res = data as { movimiento_id: string; stock_actual: number; saldo_actual: number };

    await logActivity({
      session,
      action:     ACTIVITY.MOVIMIENTO_CAJA,
      objectType: 'movimiento',
      objectId:   res.movimiento_id,
      details: {
        tipo: p.tipo, monto, bono, fichas_delta, billetera_delta,
        operador_id: p.operadorId, comprobante_id: p.comprobanteId ?? null,
        contraparte_id: p.contraparteId ?? null,
        stock_actual: res.stock_actual, saldo_actual: res.saldo_actual,
      },
    });

    return { ok: true, movimientoId: res.movimiento_id, stock: Number(res.stock_actual), saldo: Number(res.saldo_actual) };
  } catch (err: any) {
    if (isMissingCajaError(err)) return { ok: false, error: 'Caja no inicializada', degraded: true };
    return { ok: false, error: err?.message ?? 'Error al aplicar el movimiento' };
  }
}

// Recarga el pozo de fichas del tenant. SOLO agente/admin (defensa server-side;
// el operador no recarga). Valida cantidad > 0 acá y de nuevo en la función SQL.
export async function recargarFichas(session: SessionPayload, cantidad: number): Promise<RecargaResult> {
  if (session.role !== 'admin' && session.role !== 'agent') {
    return { ok: false, error: 'Solo un agente o admin puede recargar fichas' };
  }
  const monto = Math.trunc(Number(cantidad));
  if (!Number.isFinite(monto) || monto <= 0) {
    return { ok: false, error: 'La cantidad a recargar debe ser mayor a 0' };
  }

  try {
    const { data, error } = await supabaseAdmin.rpc('fn_recargar_fichas', {
      p_tenant:      session.tenant_id,
      p_cantidad:    monto,
      p_agente:      session.sub,
      p_agente_name: session.name,
    });

    if (error) {
      if (isMissingCajaError(error)) return { ok: false, error: 'Caja no inicializada', degraded: true };
      return { ok: false, error: error.message };
    }

    const stock = Number(data);

    await logActivity({
      session,
      action:     ACTIVITY.RECARGA_FICHAS,
      objectType: 'fichas_stock',
      objectId:   session.tenant_id,
      details:    { cantidad: monto, stock_actual: stock },
    });

    return { ok: true, stock };
  } catch (err: any) {
    if (isMissingCajaError(err)) return { ok: false, error: 'Caja no inicializada', degraded: true };
    return { ok: false, error: err?.message ?? 'Error al recargar fichas' };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Etapa 3 — enganche con el flujo de verificar/editar comprobantes.
//
// Red de seguridad: el descuento solo corre si el flag `caja_enabled` del tenant
// está en 'true' (arranca APAGADO). Apagado o sin migración → no descuenta y la
// verificación sigue como siempre. Encendido + sin fichas → bloquea la verif.
// ─────────────────────────────────────────────────────────────────────────────

const CAJA_FLAG_KEY = 'caja_enabled';

// Lee el flag por tenant. Default OFF (sin fila, error o valor != 'true' → false).
export async function isCajaEnabled(session: SessionPayload): Promise<boolean> {
  try {
    const { data, error } = await supabaseAdmin
      .from('settings').select('value')
      .eq('key', CAJA_FLAG_KEY).eq('tenant_id', session.tenant_id).maybeSingle();
    if (error) return false;
    return data?.value === 'true';
  } catch {
    return false;
  }
}

// applied=false  → no correspondía cobrar (caja apagada, sin migración, tipo !=
//                  carga, monto<=0, o YA cobrado): el caller verifica normal.
// ok=false       → error de negocio real (ej. fichas insuficientes): el caller
//                  NO debe verificar (consistencia: o pasan los dos o ninguno).
export type VerifyCajaResult =
  | { ok: true;  applied: boolean }
  | { ok: false; error: string };

// Descuenta una carga al verificar el comprobante. Guard anti-doble-cobro: si ya
// existe un movimiento para ese comprobante, no vuelve a cobrar (applied=false).
export async function aplicarCargaComprobante(
  session: SessionPayload,
  p: { comprobanteId: string; tipo?: string | null; monto: number; bono?: number | null },
): Promise<VerifyCajaResult> {
  if (!(await isCajaEnabled(session))) return { ok: true, applied: false };

  const tipo = p.tipo ?? 'carga';
  if (tipo !== 'carga') return { ok: true, applied: false };

  const monto = Math.trunc(Number(p.monto));
  if (!Number.isFinite(monto) || monto <= 0) return { ok: true, applied: false };

  // Guard anti-doble-cobro: un comprobante tiene UN solo movimiento asociado.
  try {
    const { data, error } = await supabaseAdmin
      .from('movimientos').select('id')
      .eq('tenant_id', session.tenant_id).eq('comprobante_id', p.comprobanteId)
      .limit(1).maybeSingle();
    if (error) {
      if (isMissingCajaError(error)) return { ok: true, applied: false };
      return { ok: false, error: error.message };
    }
    if (data) return { ok: true, applied: false }; // ya cobrado antes
  } catch (err: any) {
    if (isMissingCajaError(err)) return { ok: true, applied: false };
    return { ok: false, error: err?.message ?? 'Error verificando movimientos' };
  }

  const r = await aplicarMovimiento(session, {
    operadorId:    session.sub,
    tipo:          'carga',
    monto,
    bono:          p.bono ?? null,
    comprobanteId: p.comprobanteId,
  });
  if (r.ok) return { ok: true, applied: true };
  if (r.degraded) return { ok: true, applied: false };
  return { ok: false, error: r.error };
}

// Aplica un PAGO al verificar el comprobante: sube fichas al pozo (+monto) y baja
// la billetera del operador que verifica (-monto). Sin bono. Mismo guard
// anti-doble-cobro que las cargas (un comprobante = un movimiento).
//
//   pagoAgente=false → billetera del verificador -monto. Si no alcanza, el SQL
//                      aborta ("Saldo insuficiente en billetera") y NO se verifica.
//   pagoAgente=true  → pago manual del agente: fichas +monto, billetera intacta
//                      (no se descuenta a ningún operador).
export async function aplicarPagoComprobante(
  session: SessionPayload,
  p: { comprobanteId: string; monto: number; pagoAgente?: boolean },
): Promise<VerifyCajaResult> {
  if (!(await isCajaEnabled(session))) return { ok: true, applied: false };

  const monto = Math.trunc(Number(p.monto));
  if (!Number.isFinite(monto) || monto <= 0) return { ok: true, applied: false };

  // Guard anti-doble-cobro: un comprobante tiene UN solo movimiento asociado.
  try {
    const { data, error } = await supabaseAdmin
      .from('movimientos').select('id')
      .eq('tenant_id', session.tenant_id).eq('comprobante_id', p.comprobanteId)
      .limit(1).maybeSingle();
    if (error) {
      if (isMissingCajaError(error)) return { ok: true, applied: false };
      return { ok: false, error: error.message };
    }
    if (data) return { ok: true, applied: false }; // ya cobrado antes
  } catch (err: any) {
    if (isMissingCajaError(err)) return { ok: true, applied: false };
    return { ok: false, error: err?.message ?? 'Error verificando movimientos' };
  }

  // Pago del agente: las fichas suben igual, pero la billetera no se toca.
  // Lo modelamos pasando los deltas manualmente (fichas +monto, billetera 0)
  // a través de aplicarMovimiento, que ya calcularía -monto para 'pago'. Por eso
  // para el caso agente usamos un atajo con billetera_delta=0 vía la RPC directa.
  if (p.pagoAgente) {
    try {
      const { data, error } = await supabaseAdmin.rpc('fn_aplicar_movimiento', {
        p_tenant:          session.tenant_id,
        p_operador:        session.sub,
        p_tipo:            'pago',
        p_monto:           monto,
        p_bono:            null,
        p_fichas_delta:    monto, // sube fichas
        p_billetera_delta: 0,     // billetera intacta (pago del agente)
        p_comprobante:     p.comprobanteId,
        p_contraparte:     null,
        p_creado_por:      session.sub,
        p_creado_por_name: session.name,
      });
      if (error) {
        if (isMissingCajaError(error)) return { ok: true, applied: false };
        return { ok: false, error: error.message };
      }
      const res = data as { movimiento_id: string; stock_actual: number; saldo_actual: number };
      await logActivity({
        session,
        action:     ACTIVITY.MOVIMIENTO_CAJA,
        objectType: 'movimiento',
        objectId:   res.movimiento_id,
        details: {
          tipo: 'pago', pago_agente: true, monto,
          fichas_delta: monto, billetera_delta: 0,
          comprobante_id: p.comprobanteId,
          stock_actual: res.stock_actual, saldo_actual: res.saldo_actual,
        },
      });
      return { ok: true, applied: true };
    } catch (err: any) {
      if (isMissingCajaError(err)) return { ok: true, applied: false };
      return { ok: false, error: err?.message ?? 'Error al aplicar el pago del agente' };
    }
  }

  // Pago normal: lo paga el operador que verifica (billetera -monto, con guard).
  const r = await aplicarMovimiento(session, {
    operadorId:    session.sub,
    tipo:          'pago',
    monto,
    comprobanteId: p.comprobanteId,
  });
  if (r.ok) return { ok: true, applied: true };
  if (r.degraded) return { ok: true, applied: false };
  return { ok: false, error: r.error };
}

export type EditMovimientoResult =
  | { ok: true;  applied: boolean }
  | { ok: false; error: string };

// Reedita el movimiento del comprobante: revierte el anterior y reaplica con los
// valores nuevos SOBRE LA MISMA fila (un solo movimiento neto por comprobante).
// Si no había movimiento (histórico / caja apagada al verificar), no crea ninguno.
//
// Genérico por `tipo`:
//   carga → deltas de carga (con bono).
//   pago  → deltas de pago, SIN bono. Si pagoAgente=true (pago manual del agente),
//           la billetera no se mueve (billetera_delta=0): suben solo las fichas.
export async function editarMovimientoComprobante(
  session: SessionPayload,
  p: { comprobanteId: string; monto: number; bono?: number | null; tipo?: MovimientoTipo; pagoAgente?: boolean },
): Promise<EditMovimientoResult> {
  if (!(await isCajaEnabled(session))) return { ok: true, applied: false };

  const tipo: MovimientoTipo = p.tipo === 'pago' ? 'pago' : 'carga';
  const monto = Math.trunc(Number(p.monto));
  if (!Number.isFinite(monto) || monto <= 0) return { ok: false, error: 'Monto inválido' };
  // El bono solo aplica a cargas; en pagos se ignora.
  const bono = tipo === 'carga' && p.bono != null && Number(p.bono) > 0 ? Math.trunc(Number(p.bono)) : 0;
  let { fichas_delta, billetera_delta } = computeDeltas(tipo, monto, bono);
  // Pago del agente: las fichas suben igual, pero ninguna billetera se toca.
  if (tipo === 'pago' && p.pagoAgente) billetera_delta = 0;

  try {
    const { data, error } = await supabaseAdmin.rpc('fn_editar_movimiento_comprobante', {
      p_tenant:              session.tenant_id,
      p_comprobante:         p.comprobanteId,
      p_tipo:                tipo,
      p_monto:               monto,
      p_bono:                bono > 0 ? bono : null,
      p_new_fichas_delta:    fichas_delta,
      p_new_billetera_delta: billetera_delta,
      p_editor:              session.sub,
      p_editor_name:         session.name,
    });

    if (error) {
      if (isMissingCajaError(error)) return { ok: true, applied: false };
      return { ok: false, error: error.message };
    }

    const res = data as { applied: boolean; movimiento_id?: string; stock_actual?: number; saldo_actual?: number };
    if (res?.applied) {
      await logActivity({
        session,
        action:     ACTIVITY.MOVIMIENTO_CAJA,
        objectType: 'movimiento',
        objectId:   res.movimiento_id ?? p.comprobanteId,
        details: {
          tipo, edicion: true, monto, bono, pago_agente: !!p.pagoAgente,
          comprobante_id: p.comprobanteId,
          stock_actual: res.stock_actual, saldo_actual: res.saldo_actual,
        },
      });
    }
    return { ok: true, applied: !!res?.applied };
  } catch (err: any) {
    if (isMissingCajaError(err)) return { ok: true, applied: false };
    return { ok: false, error: err?.message ?? 'Error al reeditar el movimiento' };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Etapa 3 — Parte 4: control manual del agente (modo prueba / mantenimiento).
//
// TODAS estas funciones son SOLO admin/agent: el operator es lectura pura sobre
// la caja. El chequeo de rol va acá (server-side, defensa en profundidad además
// del middleware y el requireStaff del endpoint). Los overrides NO aplican el
// guard de negativo a propósito ("control total"): el front avisa si un ajuste
// deja stock/billetera en negativo, pero no bloquea.
// ─────────────────────────────────────────────────────────────────────────────

function isStaff(session: SessionPayload): boolean {
  return session.role === 'admin' || session.role === 'agent';
}

export type ManualResult =
  | { ok: true;  stock?: number; saldo?: number; info?: Record<string, any> }
  | { ok: false; error: string; degraded?: boolean };

// Setea el pozo a un valor exacto (override). Permite cualquier entero (incluso
// negativo: el front avisa). Registra antes/después en activity_log.
export async function setStock(session: SessionPayload, nuevo: number): Promise<ManualResult> {
  if (!isStaff(session)) return { ok: false, error: 'No autorizado' };
  const v = Math.trunc(Number(nuevo));
  if (!Number.isFinite(v)) return { ok: false, error: 'Valor inválido' };
  const tid = session.tenant_id;

  try {
    const { data: prev } = await supabaseAdmin.from('fichas_stock').select('stock_actual').eq('tenant_id', tid).maybeSingle();
    const { error } = await supabaseAdmin
      .from('fichas_stock')
      .upsert({ tenant_id: tid, stock_actual: v, updated_at: new Date().toISOString() }, { onConflict: 'tenant_id' });
    if (error) {
      if (isMissingCajaError(error)) return { ok: false, error: 'Caja no inicializada', degraded: true };
      return { ok: false, error: error.message };
    }
    await logActivity({
      session, action: ACTIVITY.CAJA_AJUSTE_MANUAL, objectType: 'fichas_stock', objectId: tid,
      details: { campo: 'stock', antes: Number(prev?.stock_actual ?? 0), despues: v },
    });
    return { ok: true, stock: v };
  } catch (err: any) {
    if (isMissingCajaError(err)) return { ok: false, error: 'Caja no inicializada', degraded: true };
    return { ok: false, error: err?.message ?? 'Error al ajustar el stock' };
  }
}

// Setea la billetera de un operador a un valor exacto (override). `nuevo`=0 sirve
// también como "resetear a cero". Permite negativo (el front avisa).
export async function setBilletera(session: SessionPayload, operadorId: string, nuevo: number): Promise<ManualResult> {
  if (!isStaff(session)) return { ok: false, error: 'No autorizado' };
  if (!operadorId) return { ok: false, error: 'Falta el operador' };
  const v = Math.trunc(Number(nuevo));
  if (!Number.isFinite(v)) return { ok: false, error: 'Valor inválido' };
  const tid = session.tenant_id;

  try {
    const { data: prev } = await supabaseAdmin
      .from('operador_billetera').select('saldo_actual').eq('tenant_id', tid).eq('operador_id', operadorId).maybeSingle();
    const { error } = await supabaseAdmin
      .from('operador_billetera')
      .upsert({ tenant_id: tid, operador_id: operadorId, saldo_actual: v, updated_at: new Date().toISOString() }, { onConflict: 'tenant_id,operador_id' });
    if (error) {
      if (isMissingCajaError(error)) return { ok: false, error: 'Caja no inicializada', degraded: true };
      return { ok: false, error: error.message };
    }
    await logActivity({
      session, action: ACTIVITY.CAJA_AJUSTE_MANUAL, objectType: 'operador_billetera', objectId: operadorId,
      details: { campo: 'billetera', operador_id: operadorId, antes: Number(prev?.saldo_actual ?? 0), despues: v },
    });
    return { ok: true, saldo: v };
  } catch (err: any) {
    if (isMissingCajaError(err)) return { ok: false, error: 'Caja no inicializada', degraded: true };
    return { ok: false, error: err?.message ?? 'Error al ajustar la billetera' };
  }
}

// Borra un movimiento y revierte su efecto en pozo + billetera (atómico en SQL).
export async function borrarMovimiento(session: SessionPayload, movimientoId: string): Promise<ManualResult> {
  if (!isStaff(session)) return { ok: false, error: 'No autorizado' };
  if (!movimientoId) return { ok: false, error: 'Falta el movimiento' };

  try {
    const { data, error } = await supabaseAdmin.rpc('fn_borrar_movimiento', {
      p_tenant: session.tenant_id,
      p_mov_id: movimientoId,
    });
    if (error) {
      if (isMissingCajaError(error)) return { ok: false, error: 'Caja no inicializada', degraded: true };
      return { ok: false, error: error.message };
    }
    const res = data as { found: boolean; stock_actual?: number; saldo_actual?: number };
    if (!res?.found) return { ok: false, error: 'El movimiento ya no existe' };

    await logActivity({
      session, action: ACTIVITY.CAJA_AJUSTE_MANUAL, objectType: 'movimiento', objectId: movimientoId,
      details: { campo: 'borrar_movimiento', stock_actual: res.stock_actual, saldo_actual: res.saldo_actual },
    });
    return { ok: true, stock: res.stock_actual, saldo: res.saldo_actual };
  } catch (err: any) {
    if (isMissingCajaError(err)) return { ok: false, error: 'Caja no inicializada', degraded: true };
    return { ok: false, error: err?.message ?? 'Error al borrar el movimiento' };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Etapa 5 — Descargas + Sueldo.
//
//   cobrarSueldo    → SOLO operador. Descuenta su sueldo_diario de su billetera.
//   crearDescarga   → SOLO operador. Crea un comprobante tipo 'descarga' pendiente
//                     (su billetera se descuenta recién al verificarlo el agente).
//   verificarDescarga → SOLO agente/admin. Mueve el monto de la billetera del
//                       operador a la del agente que verifica (atómico en SQL).
//
// Todas respetan caja_enabled: las funciones SQL fn_cobrar_sueldo /
// fn_verificar_descarga abortan con "La caja está desactivada" si el flag está
// OFF (defensa en profundidad además del pre-check de acá).
// ─────────────────────────────────────────────────────────────────────────────

export type SueldoResult =
  | { ok: true;  movimientoId: string; monto: number; saldo: number }
  | { ok: false; error: string; degraded?: boolean };

// Cobro de sueldo del operador (lo inicia él mismo). El monto sale de
// agents.sueldo_diario dentro de la función SQL; acá no se pasa.
export async function cobrarSueldo(session: SessionPayload): Promise<SueldoResult> {
  if (session.role !== 'operator') {
    return { ok: false, error: 'Solo un operador puede cobrar sueldo' };
  }
  try {
    const { data, error } = await supabaseAdmin.rpc('fn_cobrar_sueldo', {
      p_tenant_id:   session.tenant_id,
      p_operador_id: session.sub,
    });
    if (error) {
      if (isMissingCajaError(error)) return { ok: false, error: 'Caja no inicializada', degraded: true };
      return { ok: false, error: error.message };
    }
    const res = data as { movimiento_id: string; monto: number; saldo_actual: number };
    await logActivity({
      session,
      action:     ACTIVITY.MOVIMIENTO_CAJA,
      objectType: 'movimiento',
      objectId:   res.movimiento_id,
      details:    { tipo: 'sueldo', monto: Number(res.monto), saldo_actual: Number(res.saldo_actual), operador_id: session.sub },
    });
    return { ok: true, movimientoId: res.movimiento_id, monto: Number(res.monto), saldo: Number(res.saldo_actual) };
  } catch (err: any) {
    if (isMissingCajaError(err)) return { ok: false, error: 'Caja no inicializada', degraded: true };
    return { ok: false, error: err?.message ?? 'Error al cobrar el sueldo' };
  }
}

export type DescargaCreateResult =
  | { ok: true;  comprobanteId: string }
  | { ok: false; error: string; degraded?: boolean };

// Crea el comprobante de descarga PENDIENTE (lo inicia el operador). No mueve
// saldos todavía: la billetera se descuenta cuando el agente lo verifica
// (verificarDescarga). Guarda operador_id = quién la pidió, sin contacto/imagen.
export async function crearDescarga(session: SessionPayload, montoRaw: number): Promise<DescargaCreateResult> {
  if (session.role !== 'operator') {
    return { ok: false, error: 'Solo un operador puede iniciar una descarga' };
  }
  if (!(await isCajaEnabled(session))) {
    return { ok: false, error: 'La caja está desactivada' };
  }
  const monto = Math.trunc(Number(montoRaw));
  if (!Number.isFinite(monto) || monto <= 0) {
    return { ok: false, error: 'Ingresá un monto válido (mayor a 0)' };
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('comprobantes')
      .insert({
        contact_id:  null,
        image_url:   null,
        monto,
        estado:      'pendiente',
        tipo:        'descarga',
        operador_id: session.sub,
        tenant_id:   session.tenant_id,
      })
      .select('id')
      .single();
    if (error) {
      // Sin la migración stage5 (operador_id) o stage4 (tipo/contact_id nullable)
      // esto no puede funcionar: lo decimos claro.
      if (/operador_id|tipo|contact_id|null value|column|schema cache/i.test(error.message)) {
        return { ok: false, error: 'La caja no está inicializada (falta correr supabase-caja-fichas-stage5.sql).', degraded: true };
      }
      return { ok: false, error: error.message };
    }
    await logActivity({
      session,
      action:     ACTIVITY.COMPROBANTE_ENVIADO,
      objectType: 'comprobante',
      objectId:   data.id,
      details:    { tipo: 'descarga', monto, operador_id: session.sub },
    });
    return { ok: true, comprobanteId: data.id };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Error al crear la descarga' };
  }
}

export type DescargaVerifyResult =
  | { ok: true;  saldoOperador: number; saldoAgente: number }
  | { ok: false; error: string; degraded?: boolean };

// Verifica una descarga pendiente: mueve el monto de la billetera del operador a
// la del agente que verifica. SOLO agente/admin. Consistencia: si el movimiento
// SQL falla (caja apagada, saldo insuficiente), NO se marca verificado.
export async function verificarDescarga(session: SessionPayload, comprobanteId: string): Promise<DescargaVerifyResult> {
  if (!isStaff(session)) return { ok: false, error: 'No autorizado' };
  if (!comprobanteId) return { ok: false, error: 'Falta el comprobante' };

  // Traer la descarga pendiente (operador + monto) del tenant.
  const { data: comp, error: compErr } = await supabaseAdmin
    .from('comprobantes')
    .select('id, tipo, estado, monto, operador_id')
    .eq('id', comprobanteId).eq('tenant_id', session.tenant_id)
    .maybeSingle();
  if (compErr) {
    if (isMissingCajaError(compErr)) return { ok: false, error: 'Caja no inicializada', degraded: true };
    return { ok: false, error: compErr.message };
  }
  if (!comp) return { ok: false, error: 'Descarga no encontrada' };
  if (comp.tipo !== 'descarga') return { ok: false, error: 'El comprobante no es una descarga' };
  if (comp.estado !== 'pendiente') return { ok: false, error: 'La descarga ya fue resuelta' };
  if (!comp.operador_id) return { ok: false, error: 'La descarga no tiene operador asociado' };

  const monto = Math.trunc(Number(comp.monto));
  if (!Number.isFinite(monto) || monto <= 0) return { ok: false, error: 'Monto de descarga inválido' };

  // Mover saldos (atómico en SQL). Si falla, no marcamos verificado.
  let saldoOperador = 0, saldoAgente = 0;
  try {
    const { data, error } = await supabaseAdmin.rpc('fn_verificar_descarga', {
      p_tenant_id:      session.tenant_id,
      p_operador_id:    comp.operador_id,
      p_monto:          monto,
      p_comprobante_id: comprobanteId,
      p_verificado_por: session.sub,
    });
    if (error) {
      if (isMissingCajaError(error)) return { ok: false, error: 'Caja no inicializada', degraded: true };
      return { ok: false, error: error.message };
    }
    const res = data as { saldo_operador: number; saldo_agente: number };
    saldoOperador = Number(res.saldo_operador);
    saldoAgente   = Number(res.saldo_agente);
  } catch (err: any) {
    if (isMissingCajaError(err)) return { ok: false, error: 'Caja no inicializada', degraded: true };
    return { ok: false, error: err?.message ?? 'Error al verificar la descarga' };
  }

  // Marcar el comprobante como verificado (atribución de quién resolvió).
  const { error: updErr } = await supabaseAdmin
    .from('comprobantes')
    .update({ estado: 'verificado', resolved_by: session.sub, resolved_by_name: session.name, resolved_at: new Date().toISOString() })
    .eq('id', comprobanteId).eq('tenant_id', session.tenant_id);
  if (updErr) return { ok: false, error: updErr.message };

  await logActivity({
    session,
    action:     ACTIVITY.COMPROBANTE_VERIFICADO,
    objectType: 'comprobante',
    objectId:   comprobanteId,
    details:    { tipo: 'descarga', monto, operador_id: comp.operador_id, agente_id: session.sub },
  });

  return { ok: true, saldoOperador, saldoAgente };
}

// Reset total de la caja (modo prueba): pozo 0, billeteras 0, borra movimientos y
// cierres. Comprobantes solo si borrarComprobantes=true. Atómico en SQL.
export async function resetTotal(session: SessionPayload, borrarComprobantes: boolean): Promise<ManualResult> {
  if (!isStaff(session)) return { ok: false, error: 'No autorizado' };

  try {
    const { data, error } = await supabaseAdmin.rpc('fn_reset_total', {
      p_tenant: session.tenant_id,
      p_borrar_comprobantes: !!borrarComprobantes,
    });
    if (error) {
      if (isMissingCajaError(error)) return { ok: false, error: 'Caja no inicializada', degraded: true };
      return { ok: false, error: error.message };
    }
    const info = data as Record<string, any>;
    await logActivity({
      session, action: ACTIVITY.CAJA_RESET, objectType: 'caja', objectId: session.tenant_id,
      details: { borrar_comprobantes: !!borrarComprobantes, ...info },
    });
    return { ok: true, info };
  } catch (err: any) {
    if (isMissingCajaError(err)) return { ok: false, error: 'Caja no inicializada', degraded: true };
    return { ok: false, error: err?.message ?? 'Error en el reset' };
  }
}
