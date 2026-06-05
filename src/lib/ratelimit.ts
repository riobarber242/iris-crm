import { NextResponse } from 'next/server';

// Rate limiting in-memory, por IP, ventana fija.
//
// ⚠️ LIMITACIÓN EN SERVERLESS (Vercel): el estado vive en el proceso. Cada
// instancia lambda tiene su propio Map y se reinicia en cold start, así que el
// límite es por-instancia, no global. Sirve como defensa best-effort (frena
// ráfagas dentro de una instancia caliente), no como límite estricto. Para algo
// robusto y compartido hay que usar un store externo (Upstash Redis, etc.).

type Bucket = { count: number; resetAt: number };
const store = new Map<string, Bucket>();

// Limpieza perezosa para que el Map no crezca sin límite.
function prune(now: number) {
  if (store.size < 5000) return;
  for (const [k, b] of store) if (now >= b.resetAt) store.delete(k);
}

export type RateLimitResult = { ok: boolean; remaining: number; resetAt: number };

export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  const bucket = store.get(key);

  if (!bucket || now >= bucket.resetAt) {
    prune(now);
    const resetAt = now + windowMs;
    store.set(key, { count: 1, resetAt });
    return { ok: true, remaining: limit - 1, resetAt };
  }

  bucket.count++;
  if (bucket.count > limit) {
    return { ok: false, remaining: 0, resetAt: bucket.resetAt };
  }
  return { ok: true, remaining: limit - bucket.count, resetAt: bucket.resetAt };
}

// Extrae la IP del cliente respetando el proxy de Vercel.
export function getClientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return req.headers.get('x-real-ip') ?? 'unknown';
}

// Chequea el límite para `name`+IP. Devuelve una 429 lista para retornar si se
// superó, o null si está dentro del límite.
export function checkRateLimit(
  req: Request,
  name: string,
  limit: number,
  windowMs = 60_000,
): NextResponse | null {
  const ip = getClientIp(req);
  const result = rateLimit(`${name}:${ip}`, limit, windowMs);
  if (result.ok) return null;

  const retryAfter = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000));
  return NextResponse.json(
    { error: 'Demasiadas solicitudes, esperá un momento' },
    { status: 429, headers: { 'Retry-After': String(retryAfter) } },
  );
}
