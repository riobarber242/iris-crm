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

export type EditMovimientoResult =
  | { ok: true;  applied: boolean }
  | { ok: false; error: string };

// Reedita el movimiento del comprobante: revierte el anterior y reaplica con los
// valores nuevos SOBRE LA MISMA fila (un solo movimiento neto por comprobante).
// Si no había movimiento (histórico / caja apagada al verificar), no crea ninguno.
export async function editarMovimientoComprobante(
  session: SessionPayload,
  p: { comprobanteId: string; monto: number; bono?: number | null },
): Promise<EditMovimientoResult> {
  if (!(await isCajaEnabled(session))) return { ok: true, applied: false };

  const monto = Math.trunc(Number(p.monto));
  if (!Number.isFinite(monto) || monto <= 0) return { ok: false, error: 'Monto inválido' };
  const bono = p.bono != null && Number(p.bono) > 0 ? Math.trunc(Number(p.bono)) : 0;
  const { fichas_delta, billetera_delta } = computeDeltas('carga', monto, bono);

  try {
    const { data, error } = await supabaseAdmin.rpc('fn_editar_movimiento_comprobante', {
      p_tenant:              session.tenant_id,
      p_comprobante:         p.comprobanteId,
      p_tipo:                'carga',
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
          tipo: 'carga', edicion: true, monto, bono,
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
