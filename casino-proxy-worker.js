// casino-proxy-worker.js — Cloudflare Worker proxy del casino (casino-proxy).
//
// Multi-tenant (Etapa 2, PR 3): el destino ya no está hardcodeado. El backend
// manda el host del casino del tenant en el header X-Casino-Target; el Worker lo
// valida contra un allowlist y recién ahí reenvía, agregando el Origin/Referer
// del destino (lo que desbloquea el acceso). Sin header (back-compat) → default
// al host de 17Star, para no cortar el flujo actual.

// Host que el Worker usaba hardcodeado hasta el PR 2. Si el backend no manda
// X-Casino-Target (deploy viejo del CRM), se sigue proxeando a 17Star exactamente
// como antes.
const DEFAULT_TARGET = 'admin.celuapuestas.bond';

// Allowlist de hosts a los que el Worker acepta proxear. AISLADO a propósito: es
// la frontera de seguridad (aunque alguien forje X-Casino-Target, solo se llega a
// un host conocido). Sumar un casino nuevo = agregar su skin_domain acá y
// redeployar el Worker.
const ALLOWED_TARGETS = new Set([
  'admin.celuapuestas.bond',
]);

// ¿Se puede proxear a este host? Match exacto, case-insensitive, contra el
// allowlist. Fail-closed: cualquier valor vacío / no-string / desconocido → false.
function isDomainAllowed(host) {
  if (!host || typeof host !== 'string') return false;
  return ALLOWED_TARGETS.has(host.trim().toLowerCase());
}

export default {
  async fetch(request, env) {
    const secret = request.headers.get('X-Proxy-Secret');
    if (!secret || secret !== env.PROXY_SECRET) {
      return new Response('Unauthorized', { status: 401 });
    }

    // Destino del tenant (header X-Casino-Target), con back-compat al default de
    // 17Star cuando el CRM todavía no manda el header.
    const target = (request.headers.get('X-Casino-Target') || DEFAULT_TARGET).trim().toLowerCase();
    if (!isDomainAllowed(target)) {
      return new Response('Forbidden casino target', { status: 403 });
    }
    const base = `https://${target}`;

    const url = new URL(request.url);
    const targetUrl = base + url.pathname + url.search;
    const headers = new Headers(request.headers);
    headers.delete('X-Proxy-Secret');
    headers.delete('X-Casino-Target');
    headers.delete('host');
    headers.set('Origin', base);
    headers.set('Referer', base + '/');
    const casinoResponse = await fetch(targetUrl, {
      method: request.method,
      headers,
      body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
    });
    const responseHeaders = new Headers(casinoResponse.headers);
    responseHeaders.set('Access-Control-Allow-Origin', '*');
    return new Response(casinoResponse.body, {
      status: casinoResponse.status,
      statusText: casinoResponse.statusText,
      headers: responseHeaders,
    });
  },
};
