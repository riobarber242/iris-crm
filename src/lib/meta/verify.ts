import crypto from 'crypto';

export function verifyMetaSignature(
  signature: string | undefined,
  rawBody: string,
  appSecret: string | undefined,
): boolean {
  if (!appSecret) {
    // Sin ningún secret disponible (ni por número ni META_APP_SECRET global) NO se
    // puede validar la firma → se rechaza. Antes se dejaba pasar con warning; se
    // endureció para no aceptar webhooks sin verificar. Si esto rechaza tráfico
    // legítimo, falta configurar META_APP_SECRET (global) o el app_secret del número.
    console.error('[verifyMetaSignature] Sin app secret (ni por número ni META_APP_SECRET global) — rechazando por no poder validar la firma.');
    return false;
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
