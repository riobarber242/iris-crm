/* IRIS — Service Worker
 * Estrategia:
 *  - Navegaciones HTML: network-first (nunca servir HTML viejo → evita white
 *    screen / ChunkLoadError tras un deploy). Cache solo como fallback offline.
 *  - /api/*: network-only (no cacheamos datos autenticados). Fallback claro si offline.
 *  - Assets hasheados (/_next/static, imágenes, fuentes): cache-first (inmutables).
 *  - Resto: network-first con fallback a cache.
 * Ninguna rama deja que respondWith rechace: siempre se devuelve una Response.
 * Actualización: NO se hace skipWaiting automático; la página muestra un botón
 * "Actualizar" y manda el mensaje SKIP_WAITING cuando el usuario lo aprieta.
 */

const VERSION = 'v2';
const CACHE = `iris-${VERSION}`;
// Solo assets verdaderamente estáticos y públicos. Nada detrás de auth
// (precachear rutas protegidas haría fallar el install entero).
const PRECACHE = ['/icon-192.png', '/icon-512.png'];

// ── Install: precache best-effort (una URL que falle no rompe el install) ────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => Promise.allSettled(PRECACHE.map((u) => cache.add(u)))),
    // Sin skipWaiting: el SW nuevo queda "waiting" hasta que el usuario actualice.
  );
});

// ── Activate: limpiar caches viejos y tomar control ──────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// ── La página pide activar la versión nueva (botón "Actualizar") ─────────────
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

// Assets con hash/extensión estática → seguros para cache-first.
function isStaticAsset(url) {
  return (
    url.pathname.startsWith('/_next/static/') ||
    /\.(?:js|css|woff2?|ttf|otf|png|jpe?g|webp|gif|svg|ico)$/i.test(url.pathname)
  );
}

// Guarda en cache sin romper si falla (best-effort).
function putInCache(request, response) {
  if (!response || !response.ok) return;
  const copy = response.clone();
  caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // ── Navegaciones HTML: network-first ──────────────────────────────────────
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => { putInCache(request, res); return res; })
        .catch(async () => {
          const cached = (await caches.match(request)) || (await caches.match('/'));
          return cached || new Response('Sin conexión.', {
            status: 503,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          });
        }),
    );
    return;
  }

  // ── API: network-only, sin cachear datos autenticados ─────────────────────
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request).catch(() => new Response(
        JSON.stringify({ error: 'offline' }),
        { status: 503, headers: { 'Content-Type': 'application/json' } },
      )),
    );
    return;
  }

  // ── Assets estáticos hasheados: cache-first ───────────────────────────────
  if (isStaticAsset(url)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request)
          .then((res) => { putInCache(request, res); return res; })
          .catch(() => new Response('', { status: 504 }));
      }),
    );
    return;
  }

  // ── Resto: network-first con fallback a cache ─────────────────────────────
  event.respondWith(
    fetch(request)
      .then((res) => { putInCache(request, res); return res; })
      .catch(async () => (await caches.match(request)) || new Response('', { status: 504 })),
  );
});

// ── Push: mostrar notificación ──────────────────────────────────────────────
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data ? event.data.text() : '' };
  }

  const title = payload.title || 'IRIS';
  const options = {
    body: payload.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: payload.url || '/conversaciones' },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// ── Notificationclick: abrir / enfocar la URL ───────────────────────────────
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/conversaciones';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.navigate(targetUrl).catch(() => {});
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    }),
  );
});
