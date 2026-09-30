// src/lib/casino/providers/types.ts
// Contrato común de los proveedores de casino. Cada casino con el que IRIS se
// integra es un ADAPTADOR que implementa CasinoProvider y se registra en
// providers/index.ts. Sumar un casino nuevo = un archivo nuevo + una línea en el
// registro: la base no guarda la lista de proveedores (casino_accounts.provider es
// texto libre con formato validado) y la pantalla de admin arma el formulario a
// partir de `fields`.
//
// Reglas que valen para TODOS los adaptadores:
//   · Cero estado compartido entre tenants: todo lo que el adaptador necesita llega
//     en el ProviderContext de la fila del tenant. Nada de credenciales, URLs ni
//     caches globales por env.
//   · Los secretos (kind 'secret') jamás se loguean, jamás vuelven en una respuesta
//     de la API y jamás llegan al navegador.
//   · Una operación que mueve plata (deposit) NO se reintenta a ciegas: el adaptador
//     solo reintenta cuando el proveedor dijo explícitamente que no la procesó (429).

/** Columnas propias de casino_accounts de antes del modelo genérico. */
export type LegacyColumn =
  | 'agent_username'
  | 'agent_id'
  | 'skin_id'
  | 'skin_domain'
  | 'api_base_url'
  | 'agent_password_enc';

export interface ProviderField {
  key: string;
  label: string;
  kind: 'text' | 'url' | 'secret';
  required: boolean;
  help?: string;
  placeholder?: string;
  /** Valor que se usa si el campo quedó vacío (solo campos no secretos). */
  defaultValue?: string;
  /**
   * Columna propia donde vive el campo. Solo para celuapuestas, que es anterior al
   * modelo genérico y no se migra. Sin `column`, el campo va en casino_accounts.config
   * (no secreto) o dentro del blob cifrado casino_accounts.secrets_enc (secreto).
   */
  column?: LegacyColumn;
}

/** Todo lo que un adaptador sabe de UNA conexión: la fila de un único tenant. */
export interface ProviderContext {
  /** id de la fila de casino_accounts. Vacío al probar datos tipeados sin guardar. */
  accountId: string;
  tenantId: string;
  /** Campos no secretos, ya con los defaults aplicados. */
  values: Record<string, string>;
  /** Secretos en claro. Solo viven en memoria del route handler. */
  secrets: Record<string, string>;
}

// ── Resultados ────────────────────────────────────────────────────────────────

/** Por qué falló una operación. Lo usa el route para el log y para el mensaje. */
export type ProviderFailReason =
  | 'bad_credentials'   // el proveedor rechazó la key / credencial
  | 'forbidden'         // sin permiso sobre ese jugador
  | 'not_found'         // el jugador no existe
  | 'invalid'           // datos inválidos
  | 'rejected'          // el proveedor rechazó la operación y dio el motivo (p. ej. sin saldo)
  | 'rate_limited'      // límite de consultas, y se agotaron los reintentos
  | 'unavailable'       // respuesta inservible (5xx, HTML, JSON raro, red)
  | 'timeout';

export type ProviderBalanceResult =
  | { ok: true; balance: number }
  | { ok: false; reason: ProviderFailReason; error: string; detail?: string };

export type ProviderCreateResult =
  | { ok: true }
  | {
      ok: false;
      reason: ProviderFailReason;
      /** Mensaje listo para el operador (incluye el motivo del proveedor). */
      error: string;
      /** El proveedor dijo que ese usuario ya existe (para probar el correlativo). */
      taken: boolean;
      /** No se sabe si se creó (timeout, 5xx): hay que confirmarlo con un lookup. */
      ambiguous: boolean;
      detail?: string;
    };

/**
 * Resultado de una operación que mueve plata. La distinción importa más que el
 * éxito/fracaso: 'not_applied' es SEGURO de reintentar; 'ambiguous' NO (el proveedor
 * pudo haberla procesado) y hay que reconciliar antes de hacer nada.
 */
export type ProviderWriteResult =
  | { kind: 'ok' }
  | { kind: 'not_applied'; reason: ProviderFailReason; error: string; detail?: string }
  | { kind: 'ambiguous'; reason: ProviderFailReason; error: string; detail?: string };

export type ProviderTestResult =
  | { ok: true; message: string }
  | { ok: false; reason: ProviderFailReason; error: string };

// ── El contrato ───────────────────────────────────────────────────────────────

export interface CasinoProvider {
  /** Lo que se guarda en casino_accounts.provider. Formato ^[a-z0-9_]{2,40}$. */
  id: string;
  /** Nombre visible en la pantalla de admin. */
  label: string;
  fields: ProviderField[];

  /**
   * Columnas propias derivadas de los valores (celuapuestas deriva skin_domain de la
   * URL del panel). Los proveedores del modelo nuevo no lo necesitan.
   */
  deriveColumns?(values: Record<string, string>): Partial<Record<LegacyColumn, string | null>>;

  /**
   * true = crear jugador / depositar / saldo siguen corriendo por el código propio de
   * los routes (celuapuestas, que no se toca en este trabajo). El adaptador aporta
   * solo los campos y la prueba de conexión.
   */
  legacyOperations?: boolean;

  /** El proveedor expone el saldo del AGENTE. Si no, el chip de saldo se oculta. */
  hasAgentBalance: boolean;

  /** Reglas de contraseña del jugador que exige el proveedor. */
  password: { rule: RegExp; ruleText: string; generate(): string };

  testConnection(ctx: ProviderContext): Promise<ProviderTestResult>;

  // Operaciones del modelo nuevo. Obligatorias salvo con legacyOperations.
  /** opts.deadlineAt acota el alta para que al caller le quede tiempo de confirmar. */
  createPlayer?(ctx: ProviderContext, username: string, password: string, opts?: { deadlineAt?: number }): Promise<ProviderCreateResult>;
  deposit?(ctx: ProviderContext, username: string, amount: number, deadlineAt: number): Promise<ProviderWriteResult>;
  /** Saldo de un jugador. Se usa para reconciliar un depósito ambiguo. */
  playerBalance?(ctx: ProviderContext, username: string, opts?: { deadlineAt?: number; timeoutMs?: number; retry?: boolean }): Promise<ProviderBalanceResult>;
  agentBalance?(ctx: ProviderContext): Promise<number | null>;
}
