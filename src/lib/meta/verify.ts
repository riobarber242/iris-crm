import crypto from 'crypto';

const appSecret = process.env.META_APP_SECRET ?? process.env.WHATSAPP_APP_SECRET;

export function verifyMetaSignature(signature: string | undefined, rawBody: string): boolean {
  if (!signature || !appSecret) {
    return false;
  }

  const [algorithm, receivedHash] = signature.split('=');
  if (algorithm !== 'sha256' || !receivedHash) {
    return false;
  }

  const expectedHash = crypto.createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex');

  try {
    const receivedBuffer = Buffer.from(receivedHash, 'hex');
    const expectedBuffer = Buffer.from(expectedHash, 'hex');
    if (receivedBuffer.length !== expectedBuffer.length) {
      return false;
    }
    return crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
  } catch (error) {
    return false;
  }
}
