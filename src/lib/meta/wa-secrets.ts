import { decryptSecret } from '@/lib/secure-secret';

// Lectura FAIL-CLOSED de un secreto de whatsapp_numbers (access_token / app_secret).
// Cierre de la etapa "cifrado de tokens" (PR5): ya NO se mira la columna en texto
// plano. Evidencia que habilitó el corte (21/07/2026):
//   · Censo: ninguna fila tiene plano sin su *_enc; la única con plano (Derki)
//     también tiene cifrado.
//   · Logs de Vercel, 4 días: cero PLAINTEXT-FALLBACK. Como un decrypt fallido
//     caía al plano y emitía ESE MISMO log, el cero descarta las dos vías. Y el
//     modo de falla sería masivo (readWaSecret corre en cada webhook y en cada
//     envío), no algo que se esconda entre 78 warnings.
//
// Dos resultados posibles, y la diferencia entre ellos es el punto del PR5:
//   · Sin *_enc            → null. La fila NO tiene secreto propio y el caller
//                            usa el global de env (el caso legítimo de 17Star).
//   · Con *_enc que NO abre → THROW. La fila SÍ tiene secreto propio y no lo
//                            podemos leer. Antes se degradaba al plano; ahora
//                            rompe ruidoso, porque la alternativa es que
//                            resolveCreds caiga al token global y el tenant salga
//                            a enviar con la identidad de OTRO: WABA equivocada y
//                            webhooks rechazados por firma.
//
// Un envío que falla ruidoso se arregla en minutos; uno que sale con la identidad
// equivocada quema la WABA del cliente y nadie se entera.

export class WaSecretUnreadableError extends Error {
  readonly field: 'access_token' | 'app_secret';
  readonly ref: string | null;

  constructor(field: 'access_token' | 'app_secret', ref: string | null | undefined, cause: unknown) {
    super(`No se pudo descifrar ${field} de la línea ${ref ?? '?'}: ${(cause as any)?.message ?? cause}`);
    this.name = 'WaSecretUnreadableError';
    this.field = field;
    this.ref = ref ?? null;
  }
}

export function readWaSecret(
  enc: string | null | undefined,
  field: 'access_token' | 'app_secret',
  ref: string | null | undefined,   // id o phone_number_id, solo para el log
): string | null {
  // Sin cifrado: la fila no tiene secreto propio. Caso legítimo, no es un error.
  if (!enc) return null;

  try {
    return decryptSecret(enc);
  } catch (err: any) {
    console.error(`[wa-creds] DECRYPT-FAILED field=${field} ref=${ref ?? '?'} — fail-closed, NO se degrada:`, err?.message ?? err);
    throw new WaSecretUnreadableError(field, ref, err);
  }
}
