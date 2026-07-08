import crypto from 'crypto';

export function verifyMetaSignature(
  signature: string | undefined,
  rawBody: string,
  appSecret: string | undefined,
): boolean {
  if (!appSecret) {
    // Secret not configured (ni por número ni META_APP_SECRET global) — allow the
    // request but warn loudly. El caller (handler) resuelve el secret por número
    // con fallback al global; si igual no hay ninguno, se deja pasar como antes.
    // Endurecer esto (rechazar sin secret) es una tarea aparte.
    console.warn('[verifyMetaSignature] Sin app secret (ni por número ni META_APP_SECRET global) — saltando verificación de firma.');
    return true;
  }

  if (!signature) {
    console.error('[verifyMetaSignature] Sin header x-hub-signature-256 — rechazando');
    return false;
  }

  const [algorithm, receivedHash] = signature.split('=');
  if (algorithm !== 'sha256' || !receivedHash) {
    console.error(`[verifyMetaSignature] Formato de firma inválido: "${signature.slice(0, 20)}"`);
    return false;
  }

  const expectedHash = crypto
    .createHmac('sha256', appSecret)
    .update(rawBody, 'utf8')
    .digest('hex');

  try {
    const receivedBuffer = Buffer.from(receivedHash, 'hex');
    const expectedBuffer = Buffer.from(expectedHash, 'hex');
    if (receivedBuffer.length !== expectedBuffer.length) {
      console.error('[verifyMetaSignature] Firma no coincide (longitud distinta)');
      return false;
    }
    const valid = crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
    if (!valid) console.error('[verifyMetaSignature] Firma HMAC no coincide');
    return valid;
  } catch (error) {
    console.error('[verifyMetaSignature] Error comparando firmas:', error);
    return false;
  }
}
