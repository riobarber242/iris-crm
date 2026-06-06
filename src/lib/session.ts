// Signed session token — HMAC-SHA256 over a JSON payload.
// Uses Web Crypto so it runs in BOTH Node (route handlers) and Edge (middleware).
// Format: "<payloadB64url>.<sigB64url>"

export const COOKIE_NAME  = 'iris_session';
export const MAX_AGE_SEC  = 60 * 60 * 24 * 7; // 7 días

export type SessionPayload = {
  sub:  string;            // agent id
  name: string;
  role: 'admin' | 'agent' | 'operator';
  exp:  number;            // epoch seconds
};

const enc = new TextEncoder();
const dec = new TextDecoder();

function bytesToB64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function getKey(): Promise<CryptoKey> {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error('NEXTAUTH_SECRET no está configurado');
  return crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign', 'verify'],
  );
}

export async function signSession(data: Omit<SessionPayload, 'exp'>): Promise<string> {
  const payload: SessionPayload = { ...data, exp: Math.floor(Date.now() / 1000) + MAX_AGE_SEC };
  const payloadB64 = bytesToB64url(enc.encode(JSON.stringify(payload)));
  const key = await getKey();
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payloadB64));
  return `${payloadB64}.${bytesToB64url(new Uint8Array(sig))}`;
}

export async function verifySession(token: string | undefined | null): Promise<SessionPayload | null> {
  if (!token) return null;
  const [payloadB64, sigB64] = token.split('.');
  if (!payloadB64 || !sigB64) return null;
  try {
    const key   = await getKey();
    const valid = await crypto.subtle.verify('HMAC', key, b64urlToBytes(sigB64), enc.encode(payloadB64));
    if (!valid) return null;
    const payload = JSON.parse(dec.decode(b64urlToBytes(payloadB64))) as SessionPayload;
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}
