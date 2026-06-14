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
