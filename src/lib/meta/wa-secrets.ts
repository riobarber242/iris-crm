import { decryptSecret } from '@/lib/secure-secret';

// Lectura DUAL fail-OPEN de un secreto de whatsapp_numbers (access_token / app_secret).
// Etapa "cifrado de tokens" (PR1): las filas conviven cifradas (*_enc) y en texto
// plano (columna vieja) hasta que el backfill + PR5 corten el plano.
//
// Prioridad: columna CIFRADA primero; si no hay *_enc, o si el decrypt FALLA
// (clave equivocada / dato corrupto), cae a la columna PLANA. NUNCA lanza: ante
// cualquier problema devuelve lo que pueda (plano) o null. Esto es deliberado:
// resolveCreds alimenta el envío de TODOS los mensajes y la validación de firma de
// TODOS los webhooks; un error de descifrado JAMÁS debe cortar un envío ni una
// recepción en este PR. El corte fail-closed (dejar de mirar el plano) es el PR5,
// recién con evidencia (log PLAINTEXT-FALLBACK en cero + censo).
export function readWaSecret(
  enc: string | null | undefined,
  plain: string | null | undefined,
  field: 'access_token' | 'app_secret',
  ref: string | null | undefined,   // id o phone_number_id, solo para el log
): string | null {
  // 1) Camino normal: hay valor cifrado → descifrar.
  if (enc) {
    try {
      return decryptSecret(enc);
    } catch (err: any) {
      // El *_enc está pero no descifra: NO rompemos. Logueamos y seguimos al plano.
      console.error(`[wa-creds] decrypt-error field=${field} ref=${ref ?? '?'} → fallback a texto plano:`, err?.message ?? err);
      // cae abajo
    }
  }

  // 2) Fallback a texto plano (fila sin backfilear, o decrypt fallido).
  const p = (plain ?? '').trim();
  if (p) {
    // ÚNICO log que el PR5 va a contar: mientras aparezca, NO se corta el fallback.
    console.warn(`[wa-creds] PLAINTEXT-FALLBACK field=${field} ref=${ref ?? '?'}`);
    return p;
  }

  // 3) Ni cifrado ni plano: null. El caller decide (p.ej. resolveCreds cae al token
  //    global de env, que es el comportamiento legítimo del tenant Principal).
  return null;
}
