// src/lib/casino/providers/index.ts
// Registro de proveedores de casino. Para sumar un casino nuevo:
//   1. crear providers/<id>.ts implementando CasinoProvider (ver types.ts);
//   2. agregarlo a PROVIDERS acá abajo.
// No hace falta migración: casino_accounts.provider guarda el id y los campos del
// proveedor van en config / secrets_enc. La pantalla de admin lista lo que haya acá.

import { agentesplusProvider } from './agentesplus';
import { celuapuestasProvider } from './celuapuestas';
import type { CasinoProvider } from './types';

export const DEFAULT_PROVIDER_ID = 'celuapuestas';

const PROVIDERS: Record<string, CasinoProvider> = {
  [celuapuestasProvider.id]: celuapuestasProvider,
  [agentesplusProvider.id]:  agentesplusProvider,
};

export function getProvider(id: string | null | undefined): CasinoProvider | null {
  return PROVIDERS[id ?? ''] ?? null;
}

export function listProviders(): CasinoProvider[] {
  return Object.values(PROVIDERS);
}

/** Lo que la pantalla de admin necesita para armar el formulario (sin nada secreto). */
export function providerCatalog() {
  return listProviders().map((p) => ({
    id: p.id,
    label: p.label,
    hasAgentBalance: p.hasAgentBalance,
    /** Herramientas de prueba del admin (saldo / alta / depósito): solo modelo nuevo. */
    testTools: !p.legacyOperations,
    fields: p.fields.map(({ key, label, kind, required, help, placeholder, defaultValue }) => ({
      key, label, kind, required, help: help ?? null, placeholder: placeholder ?? null, defaultValue: defaultValue ?? null,
    })),
  }));
}

export type { CasinoProvider } from './types';
