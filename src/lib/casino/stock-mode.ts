// src/lib/casino/stock-mode.ts
// ¿Quién lleva el stock de fichas del tenant? Una sola respuesta para todo IRIS
// (verificar comprobantes, saldo del casino, caja del operador y las pantallas):
//
//   'manual' → casino desactivado. La caja interna (pozo + billeteras) es la verdad.
//   'casino' → casino activado y el proveedor da el saldo del AGENTE (17Star): el
//              stock vive en el casino y el pozo interno queda dormido.
//   'hybrid' → casino activado y el proveedor NO da el saldo del agente: se acredita
//              en el casino y ADEMÁS la caja funciona exactamente como en manual
//              (pozo, interruptor, Cargar fichas), porque es el único stock visible.
//
// Genérico: sale del flag casino_deposit_enabled y de `hasAgentBalance` del
// adaptador del proveedor. Cuando un adaptador pase a dar el saldo del agente, sus
// tenants pasan solos de 'hybrid' a 'casino', sin tocar nada más.
//
// Criterio seguro: 'hybrid' SOLO cuando el proveedor es conocido y dice
// explícitamente que no tiene saldo del agente. Ante cualquier duda (fila ilegible,
// proveedor desconocido, sin fila) queda 'casino', que es el comportamiento de
// siempre con el casino activado.

import { supabaseAdmin } from '@/lib/db';
import { getProvider } from './providers';
import { getTenantProviderId } from './provider-account';

export type CasinoStockMode = 'manual' | 'casino' | 'hybrid';

/** Decisión pura (sin base), para poder probarla aparte. */
export function stockModeFrom(casinoFlagOn: boolean, providerId: string | null): CasinoStockMode {
  if (!casinoFlagOn) return 'manual';
  const provider = providerId ? getProvider(providerId) : null;
  if (provider && !provider.hasAgentBalance) return 'hybrid';
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
  return stockModeFrom(true, await getTenantProviderId(tenantId));
}
