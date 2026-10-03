// src/lib/casino/stock-mode.ts
// ¿Quién lleva el stock de fichas del tenant? Una sola respuesta para todo IRIS
// (verificar comprobantes, saldo del casino, caja del operador y las pantallas):
//
//   'manual' → casino desactivado. La caja interna (pozo + billeteras) es la verdad.
//   'casino' → casino activado y la cuenta da el saldo del AGENTE (17Star; o una
//              cuenta de agentes.plus con el saldo del panel activado): el stock vive
//              en el casino y el pozo interno queda dormido.
//   'hybrid' → casino activado y la cuenta NO da el saldo del agente: se acredita
//              en el casino y ADEMÁS la caja funciona exactamente como en manual
//              (pozo, interruptor, Cargar fichas), porque es el único stock visible.
//
// Genérico: sale del flag casino_deposit_enabled y de accountHasAgentBalance()
// (provider.hasAgentBalance, o optionalAgentBalance + la marca que pone el admin al
// activar el saldo del agente después de probarlo). Una lectura fallida del saldo NO
// cambia el modo: solo lo cambia el admin.
//
// Criterio seguro: 'hybrid' SOLO cuando el proveedor es conocido y la cuenta no da
// el saldo del agente. Ante cualquier duda (fila ilegible, proveedor desconocido, sin
// fila) queda 'casino', que es el comportamiento de siempre con el casino activado.

import { supabaseAdmin } from '@/lib/db';
import { getProvider } from './providers';
import { accountHasAgentBalance, getTenantProviderInfo } from './provider-account';

export type CasinoStockMode = 'manual' | 'casino' | 'hybrid';

/** Decisión pura (sin base), para poder probarla aparte. */
export function stockModeFrom(casinoFlagOn: boolean, providerId: string | null, config?: unknown): CasinoStockMode {
  if (!casinoFlagOn) return 'manual';
  const provider = providerId ? getProvider(providerId) : null;
  if (provider && !accountHasAgentBalance(provider, config)) return 'hybrid';
  return 'casino';
}

async function readCasinoFlag(tenantId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from('settings').select('value')
    .eq('key', 'casino_deposit_enabled').eq('tenant_id', tenantId).maybeSingle();
  if (error) return false;
  return data?.value === 'true';
}

/**
 * Modo de stock del tenant. Si el caller ya leyó el flag, lo pasa y se ahorra la
 * consulta. Con el flag apagado no se lee el proveedor.
 */
export async function getCasinoStockMode(tenantId: string, casinoFlagOn?: boolean): Promise<CasinoStockMode> {
  const flag = casinoFlagOn ?? await readCasinoFlag(tenantId);
  if (!flag) return 'manual';
  const info = await getTenantProviderInfo(tenantId);
  return stockModeFrom(true, info.providerId, info.config);
}
