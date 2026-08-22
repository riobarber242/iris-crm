// src/lib/casino/session-store.ts
// Cache PERSISTENTE del access token del casino (tabla casino_sessions).
//
// El cache en memoria de client.ts vive por instancia de función serverless, así que
// cada cold start y cada instancia nueva volvía a pedir token. Medición del
// 21/08/2026 en prod: ~94 Authenticate por hora (~2.250/día), el 100% disparados por
// el polling del chip de saldo, contra un token que el casino declara válido 1 hora.
// Guardándolo acá el mismo tráfico necesita ~24 logins por día.
//
// Contrato de este módulo: NUNCA lanza y NUNCA rompe el flujo del casino. Es un
// cache: si la tabla no existe todavía, si falla el cifrado o si la base contesta
// mal, se comporta como "no hay nada guardado" y el caller pide un token nuevo. Un
// cache que voltea la operación que venía a acelerar no sirve de nada.

import { supabaseAdmin } from '@/lib/db';
import { decryptSecret, encryptSecret } from '@/lib/secure-secret';
import type { CasinoCreds } from './account';

export interface StoredSession {
  token: string;
  /** Epoch ms. Ya tiene aplicado el margen de seguridad. */
  expiresAt: number;
}

// La tabla se crea a mano (supabase-casino-sessions.sql). Mientras no exista, este
// módulo tiene que ser inocuo — pero sin llenar los logs con el mismo error en cada
// request. Se avisa UNA vez por instancia y después se sigue en silencio.
let avisoTablaFaltante = false;

function esTablaFaltante(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  // PostgREST: 42P01 = undefined_table; PGRST205 = no está en el schema cache.
  return err.code === '42P01' || err.code === 'PGRST205' || /casino_sessions/i.test(err.message ?? '');
}

function loguearFalla(op: string, err: { code?: string; message?: string } | null) {
  if (esTablaFaltante(err)) {
    if (!avisoTablaFaltante) {
      avisoTablaFaltante = true;
      console.warn(
        '[casino/session] la tabla casino_sessions todavía no existe — el token se cachea sólo en memoria. ' +
        'Correr supabase-casino-sessions.sql en Supabase para activar el cache persistente.',
      );
    }
    return;
  }
  console.warn(`[casino/session] ${op} falló:`, err?.message ?? err);
}

// Sin fila propia en casino_accounts no hay dónde guardar (es el caso del
// "Probar conexión" con credenciales tipeadas y todavía no guardadas). Que esas
// pruebas NO persistan token es lo correcto, no una limitación.
const sinDondeGuardar = (creds: CasinoCreds) => !creds.accountId;

export async function readSession(creds: CasinoCreds): Promise<StoredSession | null> {
  if (sinDondeGuardar(creds)) return null;

  try {
    const { data, error } = await supabaseAdmin
      .from('casino_sessions')
      .select('access_token_enc, expires_at')
      .eq('account_id', creds.accountId!)
      .maybeSingle();

    if (error) { loguearFalla('readSession', error); return null; }
    if (!data?.access_token_enc) return null;

    const expiresAt = new Date(data.expires_at).getTime();
    // Vencido (o fecha ilegible) → como si no hubiera nada. No lo borramos acá: el
    // próximo writeSession lo pisa igual, y una lectura no debería escribir.
    if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt) return null;

    return { token: decryptSecret(data.access_token_enc), expiresAt };
  } catch (err: any) {
    // Incluye el descifrado: si rotaron SECRET_ENC_KEY, el blob viejo no se puede
    // abrir y hay que pedir token nuevo, no explotar.
    loguearFalla('readSession', { message: err?.message ?? String(err) });
    return null;
  }
}

export async function writeSession(creds: CasinoCreds, sesion: StoredSession): Promise<void> {
  if (sinDondeGuardar(creds)) return;

  try {
    const { error } = await supabaseAdmin
      .from('casino_sessions')
      .upsert({
        account_id:       creds.accountId!,
        tenant_id:        creds.tenantId,
        access_token_enc: encryptSecret(sesion.token),
        expires_at:       new Date(sesion.expiresAt).toISOString(),
        obtained_at:      new Date().toISOString(),
        last_401_at:      null,     // token nuevo: el rechazo anterior ya no aplica
      }, { onConflict: 'account_id' });

    if (error) loguearFalla('writeSession', error);
  } catch (err: any) {
    loguearFalla('writeSession', { message: err?.message ?? String(err) });
  }
}

// Borra el token guardado. `rechazado` marca que lo tiramos por un 401 del casino
// (queda en last_401_at para diagnóstico), y no por un vencimiento normal.
export async function deleteSession(creds: CasinoCreds, rechazado = false): Promise<void> {
  if (sinDondeGuardar(creds)) return;

  try {
    if (rechazado) {
      // El sello del rechazo se guarda ANTES de borrar la fila: si no, se pierde el
      // dato de cuándo el casino empezó a rechazarnos.
      const { error } = await supabaseAdmin
        .from('casino_sessions')
        .update({ last_401_at: new Date().toISOString(), expires_at: new Date(0).toISOString() })
        .eq('account_id', creds.accountId!);
      if (error) loguearFalla('deleteSession(rechazado)', error);
      return;
    }

    const { error } = await supabaseAdmin
      .from('casino_sessions')
      .delete()
      .eq('account_id', creds.accountId!);
    if (error) loguearFalla('deleteSession', error);
  } catch (err: any) {
    loguearFalla('deleteSession', { message: err?.message ?? String(err) });
  }
}
