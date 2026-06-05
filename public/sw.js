/* IRIS CRM — Service Worker
 * - Assets estáticos: cache-first
 * - API routes (/api/*): network-first
 * - Push notifications + click-to-open
 */

const CACHE = 'iris-crm-v1';
const PRECACHE = [
  '/',
  '/dashboard',
  '/conversations',
  '/icon-192.png',
  '/icon-512.png',
];

// ── Install: precache el shell ──────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()),
  );
});

// ── Activate: limpiar caches viejos ─────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// ── Fetch: estrategia según tipo de request ─────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Solo manejamos requests del propio origen.
  if (url.origin !== self.location.origin) return;

  // API: network-first (datos siempre frescos; cache como fallback offline).
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(request)),
    );
    return;
  }

  // Assets estáticos: cache-first (rápido; red como fallback y se cachea).
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
        return res;
      });
    }),
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
    data: { url: payload.url || '/conversations' },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// ── Notificationclick: abrir / enfocar la URL ───────────────────────────────
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/conversations';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Si ya hay una ventana abierta, enfocarla y navegar.
      for (const client of clientList) {
        if ('focus' in client) {
          client.navigate(targetUrl).catch(() => {});
          return client.focus();
        }
      }
      // Si no, abrir una nueva.
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    }),
  );
});
