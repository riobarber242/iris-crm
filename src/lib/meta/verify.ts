import crypto from 'crypto';

export function verifyMetaSignature(signature: string | undefined, rawBody: string): boolean {
  const appSecret = process.env.META_APP_SECRET ?? process.env.WHATSAPP_APP_SECRET;

  if (!appSecret) {
    // Secret not configured — allow the request but warn loudly.
    // Set META_APP_SECRET in Vercel env vars to enable full signature verification.
    console.warn('[verifyMetaSignature] META_APP_SECRET no configurado — saltando verificación de firma. Configurá la variable de entorno en Vercel.');
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
