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

const VERSION = 'v5';
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
  const url   = payload.url || '/conversaciones';

  // `tag` agrupa las notificaciones: las del mismo destino (misma conversación,
  // o la cola de cargas/pagos) se REEMPLAZAN en vez de apilarse. Se deriva de la
  // URL → único por conversación (/conversaciones/{id}) y por bandeja (/cargas,
  // /pagos). `renotify` hace que el reemplazo igual avise (salvo los silenciosos).
  const tag = payload.tag || url;

  const isComprobante = payload.kind === 'comprobante';

  const options = {
    body: payload.body || '',
    // Recursos PROPIOS, servidos por el origen donde está instalada la PWA
    // (irisonline.app). Relativos a propósito: nunca apuntar a un dominio ajeno.
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag,
    renotify: true,
    // Sonido solo para conversaciones. Los comprobantes (carga/pago a verificar)
    // llegan en silencio: el operador los ve por el badge, sin ruido en pantalla
    // bloqueada. (Android/desktop respetan `silent`; iOS lo ignora a nivel SO.)
    silent: isComprobante,
    // Vibración solo en conversaciones: refuerza el aviso en pantalla bloqueada
    // (Android). No fuerza interacción (se puede autodescartar como siempre).
    vibrate: isComprobante ? undefined : [200, 100, 200],
    requireInteraction: false,
    data: { url },
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
