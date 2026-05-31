import crypto from 'crypto';

const appSecret = process.env.META_APP_SECRET ?? process.env.APP_SECRET;

if (!appSecret) {
  throw new Error('Falta META_APP_SECRET o APP_SECRET en las variables de entorno');
}

export function verifyMetaSignature(signature: string | undefined, rawBody: string): boolean {
  if (!signature) {
    return false;
  }

  const hmac = crypto.createHmac('sha256', String(appSecret));
  hmac.update(rawBody, 'utf8');
  const expected = `sha256=${hmac.digest('hex')}`;

  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch (e) {
    return false;
  }
}
