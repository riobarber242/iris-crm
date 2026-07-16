import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

// Cifrado simétrico de secretos sensibles guardados en la DB (p.ej. el
// password/token del agente del casino en casino_accounts.agent_password_enc).
// Genérico a propósito: mismo helper para futuros secretos por-tenant (tokens de
// WhatsApp, etc.). Solo corre en runtime Node (route handlers), nunca en Edge.
//
// AES-256-GCM: confidencialidad + integridad (el auth tag detecta manipulación).
// A diferencia del hash de auth.ts (scrypt, de una sola vía, para VERIFICAR un
// login), acá necesitamos recuperar el secreto en claro para autenticar contra un
// servicio externo → cifrado reversible, no hash. Nunca se guarda en texto plano:
// un dump de la DB, un log, o un usuario de solo-lectura no deben exponer el
// secreto. La clave maestra vive en env (separada de la DB); comprometer un
// secreto exige DB + env, no uno solo.
//
// Formato guardado (auto-descriptivo, versionado por el prefijo de esquema):
//   "gcm$<ivB64>$<tagB64>$<ciphertextB64>"
//
// Clave: env SECRET_ENC_KEY = 32 bytes en base64 (AES-256). Generar una con:
//   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

const SCHEME = 'gcm';
const IV_LEN = 12;   // 96 bits, tamaño recomendado para GCM
const KEY_LEN = 32;  // AES-256

function getKey(): Buffer {
  const raw = process.env.SECRET_ENC_KEY;
  if (!raw) throw new Error('SECRET_ENC_KEY no está configurada (clave de cifrado de secretos)');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_LEN) {
    throw new Error(`SECRET_ENC_KEY debe ser ${KEY_LEN} bytes en base64 (AES-256); se leyeron ${key.length}`);
  }
  return key;
}

// True si la clave de cifrado está presente y bien formada. Para que un caller
// (p.ej. el settings route) pueda avisar "falta configurar el cifrado" en vez de
// tirar 500 al intentar cifrar.
export function isSecretEncryptionConfigured(): boolean {
  try { getKey(); return true; } catch { return false; }
}

export function encryptSecret(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [SCHEME, iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join('$');
}

export function decryptSecret(stored: string): string {
  const key = getKey();
  const [scheme, ivB64, tagB64, ctB64] = (stored ?? '').split('$');
  if (scheme !== SCHEME || !ivB64 || !tagB64 || !ctB64) {
    throw new Error('Formato de secreto cifrado inválido');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  // .final() lanza si el auth tag no valida (secreto o clave manipulados).
  const pt = Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]);
  return pt.toString('utf8');
}

// True si `stored` tiene la pinta de un secreto cifrado por este módulo (para
// distinguir, en la migración, un valor ya cifrado de uno en texto plano viejo).
export function isEncryptedSecret(stored: string | null | undefined): boolean {
  return typeof stored === 'string' && stored.startsWith(`${SCHEME}$`);
}
