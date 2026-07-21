'use client';

import { useEffect, useState, useCallback } from 'react';
import { usePathname } from 'next/navigation';
import { useAuth } from './AuthProvider';
import { fetchWithTimeout } from '@/lib/fetchWithTimeout';

// Páginas PÚBLICAS (sin login) que se comparten fuera del equipo: la política de
// privacidad que revisa Meta y las páginas informativas que se le mandan al
// cliente. Este componente vive en el layout raíz, así que sin este filtro el
// banner interno de "Activá las notificaciones" les aparecía a ellos.
const RUTAS_PUBLICAS = ['/privacidad', '/info', '/login'];

// Convierte la VAPID public key (base64url) a Uint8Array para pushManager.subscribe.
function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// Promise.race con timeout para APIs que NO aceptan AbortSignal
// (serviceWorker.ready, pushManager.subscribe). Si se vence, rechaza con un
// error claro para que el caller corte el spinner en vez de colgarse para
// siempre. Limpia el timer pase lo que pase.
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timeout: ${label} (${ms} ms)`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

// iOS/iPadOS (todo WebKit). En iPad moderno el UA dice "Macintosh" pero hay touch.
function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return /iphone|ipad|ipod/i.test(ua)
    || (/Macintosh/.test(ua) && typeof document !== 'undefined' && 'ontouchend' in document);
}

// ¿La app corre como PWA instalada (standalone)? En iOS el push SOLO existe ahí.
function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(display-mode: standalone)').matches
    || (window.navigator as unknown as { standalone?: boolean }).standalone === true;
}

// Dónde falló la activación (para el diagnóstico consultable en activity_log).
type PushStage = 'sw-ready' | 'subscribe' | 'server-post' | 'permission' | 'done';

// Traduce la excepción real (DOMException.name, timeout propio, error del server)
// a un código corto + un mensaje legible para el agente. El código va al log; el
// mensaje va al banner. Así dejamos de mostrar el genérico "Reintentá".
function describePushError(err: unknown): { code: string; message: string } {
  const name = (err as { name?: string })?.name ?? '';
  const msg  = String((err as { message?: string })?.message ?? err ?? '');

  if (name === 'TimeoutError' || /^Timeout:/.test(msg))
    return { code: 'timeout', message: 'El navegador tardó demasiado en responder. Revisá la conexión e intentá de nuevo.' };
  if (name === 'NotAllowedError')
    return { code: 'permission-denied', message: 'Las notificaciones están bloqueadas. Activalas desde los ajustes del navegador y recargá.' };
  if (name === 'AbortError')
    return { code: 'push-service', message: 'No se pudo conectar con el servicio de notificaciones de Google en este teléfono. Puede ser Google Play Services, el ahorro de batería, un DNS privado o una VPN.' };
  if (name === 'InvalidStateError' || name === 'InvalidAccessError')
    return { code: 'stale-subscription', message: 'Había una suscripción anterior incompatible. Tocá "Reintentar" (se limpia sola).' };
  if (name === 'InvalidCharacterError')
    return { code: 'bad-key', message: 'La clave de notificaciones del servidor está mal configurada. Avisá al soporte de IRIS.' };
  if (name === 'NotSupportedError')
    return { code: 'unsupported', message: 'Este navegador no soporta notificaciones push.' };
  if (/HTTP\s+\d+/.test(msg))
    return { code: 'server', message: `El servidor rechazó la suscripción (${msg.match(/HTTP\s+\d+/)?.[0]}).` };
  return { code: 'unknown', message: `No se pudieron activar las notificaciones${name ? ` (${name})` : ''}. Reintentá.` };
}

// Contexto del dispositivo que mandamos junto al diagnóstico.
function pushContext() {
  return {
    userAgent:     typeof navigator !== 'undefined' ? navigator.userAgent : null,
    permission:    typeof Notification !== 'undefined' ? Notification.permission : null,
    standalone:    isStandalone(),
    pushSupported: typeof window !== 'undefined'
      && 'PushManager' in window && 'serviceWorker' in navigator && 'Notification' in window,
  };
}

// Envía el resultado del intento (éxito o fallo) al server para dejarlo en
// activity_log. Best-effort: nunca bloquea ni lanza (el banner ya informó).
function postDiagnostics(payload: Record<string, unknown>) {
  try {
    fetchWithTimeout('/api/push/diagnostics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...pushContext(), ...payload }),
    }, 8000).catch(() => {});
  } catch { /* nunca bloquea la activación */ }
}

// ¿La suscripción existente fue creada con la MISMA VAPID key que usamos ahora?
// Si rotó la key, la vieja quedó desapareada y hay que rehacerla. Si no podemos
// leer la key existente, asumimos que está OK (no forzamos rehacer sin motivo).
function sameApplicationServerKey(sub: PushSubscription, key: Uint8Array<ArrayBuffer>): boolean {
  const existing = sub.options?.applicationServerKey;
  if (!existing) return true;
  const a = new Uint8Array(existing);
  if (a.length !== key.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== key[i]) return false;
  return true;
}

// Crea una suscripción nueva (con timeout, porque subscribe() no acepta AbortSignal).
function subscribeFresh(registration: ServiceWorkerRegistration, appServerKey: Uint8Array<ArrayBuffer>) {
  return withTimeout(
    registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appServerKey }),
    12000, 'suscripción push',
  );
}

// Estado del afiche de notificaciones que mostramos al operador.
//  null        → no mostrar nada
//  'prompt'    → botón "Activar notificaciones" (permiso 'default', soportado)
//  'ios-install' → iOS en pestaña: hay que instalar la PWA para tener push
type PushPrompt = null | 'prompt' | 'ios-install';

// Registra el service worker, gestiona el aviso de "nueva versión" y la
// activación de push. El permiso se pide SOLO desde un gesto del usuario
// (requisito de Safari; Chrome/Firefox lo aceptan igual).
export default function PWARegister() {
  const { agent } = useAuth();
  const pathname = usePathname();
  const [waitingWorker, setWaitingWorker] = useState<ServiceWorker | null>(null);
  const [pushPrompt, setPushPrompt] = useState<PushPrompt>(null);
  const [dismissed, setDismissed] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const vapidKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;

  // ── Registro del SW + detección de versión nueva ──────────────────────────
  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
    // NO registrar el SW en dev: su fallback de navegación (caches.match('/'))
    // sirve la landing para cualquier ruta cuando el fetch falla, y `next dev`
    // recompila seguido → todas las rutas mostraban la landing "sin sesión".
    // El SW solo tiene sentido en prod (PWA instalada / push). Además, desregistramos
    // cualquier SW viejo que haya quedado de una corrida previa, así dev queda SW-free
    // sin tener que limpiarlo a mano en el navegador.
    if (process.env.NODE_ENV !== 'production') {
      navigator.serviceWorker.getRegistrations?.()
        .then((regs) => regs.forEach((r) => r.unregister()))
        .catch(() => {});
      return;
    }

    let reloaded = false;

    navigator.serviceWorker.register('/sw.js').then((registration) => {
      console.log('[PWA] SW registrado:', registration.scope);

      if (registration.waiting && navigator.serviceWorker.controller) {
        setWaitingWorker(registration.waiting);
      }

      registration.addEventListener('updatefound', () => {
        const installing = registration.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
          if (installing.state === 'installed' && navigator.serviceWorker.controller) {
            setWaitingWorker(installing);
          }
        });
      });
    }).catch((err) => console.warn('[PWA] Error registrando SW:', err));

    const onControllerChange = () => {
      if (reloaded) return;
      reloaded = true;
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
    return () => navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
  }, []);

  // Suscribe al push (no pide permiso: asume que ya está 'granted'). Idempotente.
  // Reporta el resultado a /api/push/diagnostics (éxito solo si creó una
  // suscripción NUEVA, para no spamear en cada carga; fallo siempre). Ante error
  // re-lanza con la causa para que el caller la muestre en el banner.
  const ensureSubscription = useCallback(async () => {
    if (!agent || !vapidKey) return;
    let stage: PushStage = 'sw-ready';
    let createdNew = false;
    try {
      const registration = await withTimeout(
        navigator.serviceWorker.ready, 12000, 'service worker listo',
      );

      stage = 'subscribe';
      const appServerKey = urlBase64ToUint8Array(vapidKey);
      let subscription = await registration.pushManager.getSubscription();

      // Suscripción vieja creada con otra VAPID key → limpiarla y rehacer.
      if (subscription && !sameApplicationServerKey(subscription, appServerKey)) {
        await subscription.unsubscribe().catch(() => {});
        subscription = null;
      }

      if (!subscription) {
        try {
          subscription = await subscribeFresh(registration, appServerKey);
        } catch (subErr) {
          // Suscripción anterior incompatible: limpiar y reintentar UNA vez.
          const n = (subErr as { name?: string })?.name;
          if (n === 'InvalidStateError' || n === 'InvalidAccessError') {
            const old = await registration.pushManager.getSubscription();
            if (old) await old.unsubscribe().catch(() => {});
            subscription = await subscribeFresh(registration, appServerKey);
          } else {
            throw subErr;
          }
        }
        createdNew = true;
      }

      stage = 'server-post';
      const res = await fetchWithTimeout('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription, agentId: agent.id }),
      }, 15000);
      if (!res.ok) throw new Error(`El servidor rechazó la suscripción (HTTP ${res.status})`);

      if (createdNew) postDiagnostics({ ok: true, stage: 'done' });
    } catch (err) {
      const info = describePushError(err);
      postDiagnostics({
        ok: false, stage, code: info.code,
        errorName:    (err as { name?: string })?.name ?? null,
        errorMessage: String((err as { message?: string })?.message ?? err),
      });
      throw err;
    }
  }, [agent, vapidKey]);

  // ── Decidir qué afiche mostrar (depende del agente logueado) ───────────────
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!agent) { setPushPrompt(null); return; }

    const supported = 'serviceWorker' in navigator
      && 'PushManager' in window
      && 'Notification' in window;

    if (!supported) {
      // iOS en pestaña: las APIs de push no existen hasta instalar la PWA.
      setPushPrompt(isIOS() && !isStandalone() ? 'ios-install' : null);
      return;
    }

    if (!vapidKey) {
      console.warn('[pwa] NEXT_PUBLIC_VAPID_PUBLIC_KEY no configurada — sin push');
      setPushPrompt(null);
      return;
    }

    // Permiso ya concedido → suscribir en silencio (no requiere gesto).
    if (Notification.permission === 'granted') {
      ensureSubscription().catch((err) => console.warn('[pwa] Error suscribiendo push:', err));
      setPushPrompt(null);
      return;
    }

    // 'denied' → no insistimos (el usuario lo bloqueó). 'default' → ofrecer botón.
    setPushPrompt(Notification.permission === 'default' ? 'prompt' : null);
  }, [agent, vapidKey, ensureSubscription]);

  // Click del usuario → recién acá pedimos permiso (obligatorio en Safari).
  async function enableNotifications() {
    setWorking(true);
    setError(null);
    try {
      const permission = await Notification.requestPermission();
      if (permission === 'granted') {
        await ensureSubscription();
        setPushPrompt(null);
      } else if (permission === 'denied') {
        postDiagnostics({
          ok: false, stage: 'permission', code: 'permission-denied',
          errorName: 'NotAllowedError', errorMessage: 'permiso denegado por el usuario',
        });
        setError('Bloqueaste las notificaciones. Activalas desde el candado del navegador y recargá.');
      } else {
        // 'default' → cerró el prompt sin decidir. Dejamos el banner para reintentar.
        setError('No se completó la activación. Probá de nuevo.');
      }
    } catch (err) {
      // Mostramos la causa real (mapeada) en vez del genérico. El diagnóstico ya
      // quedó registrado dentro de ensureSubscription.
      console.warn('[pwa] Error activando notificaciones:', err);
      setError(describePushError(err).message);
    } finally {
      setWorking(false);
    }
  }

  function applyUpdate() {
    waitingWorker?.postMessage({ type: 'SKIP_WAITING' });
    setWaitingWorker(null);
  }

  // En las páginas públicas no mostramos NADA de la UI interna (ni el banner de
  // notificaciones ni el de "hay una versión nueva"): las ve gente de afuera.
  // El registro del service worker de arriba sí sigue corriendo, no molesta.
  const esPublica = RUTAS_PUBLICAS.some((r) => pathname === r || pathname?.startsWith(r + '/'));

  const showPush = pushPrompt !== null && !dismissed;
  if (esPublica || (!waitingWorker && !showPush)) return null;

  return (
    <>
    {(waitingWorker || showPush) && (
    <div
      style={{
        position: 'fixed', bottom: '16px', left: '50%', transform: 'translateX(-50%)',
        zIndex: 9999, display: 'flex', flexDirection: 'column', gap: '10px',
        alignItems: 'center', maxWidth: 'calc(100vw - 32px)',
      }}
    >
      {/* ── Activar notificaciones (Chrome / Safari escritorio / Firefox) ── */}
      {showPush && pushPrompt === 'prompt' && (
        <div style={bannerStyle} role="status">
          <span style={{ fontSize: '14px', color: error ? '#ffb3b3' : '#fff' }}>
            {error ?? '🔔 Activá las notificaciones para enterarte de mensajes nuevos'}
          </span>
          <button onClick={enableNotifications} disabled={working} style={primaryBtn}>
            {working ? 'Activando…' : error ? 'Reintentar' : 'Activar'}
          </button>
          <button onClick={() => setDismissed(true)} aria-label="Cerrar" style={closeBtn}>✕</button>
        </div>
      )}

      {/* ── iOS en pestaña: hay que instalar la PWA para recibir push ── */}
      {showPush && pushPrompt === 'ios-install' && (
        <div style={bannerStyle} role="status">
          <span style={{ fontSize: '14px', lineHeight: 1.4 }}>
            🔔 Para recibir notificaciones, agregá IRIS a tu pantalla de inicio:
            tocá <strong>Compartir</strong> y luego <strong>“Agregar a inicio”</strong>.
          </span>
          <button onClick={() => setDismissed(true)} aria-label="Cerrar" style={closeBtn}>✕</button>
        </div>
      )}

      {/* ── Nueva versión disponible ── */}
      {waitingWorker && (
        <div style={bannerStyle} role="status">
          <span style={{ fontSize: '14px' }}>Hay una nueva versión disponible</span>
          <button onClick={applyUpdate} style={primaryBtn}>Actualizar</button>
        </div>
      )}
    </div>
    )}
    </>
  );
}

const bannerStyle: React.CSSProperties = {
  background: '#1a1a1a', color: '#fff',
  borderRadius: '12px', padding: '10px 12px 10px 16px',
  display: 'flex', alignItems: 'center', gap: '12px',
  boxShadow: '0 6px 24px rgba(0,0,0,0.32)', maxWidth: '100%',
};

const primaryBtn: React.CSSProperties = {
  background: '#C8FF00', color: '#000', fontWeight: 700, fontSize: '14px',
  border: 'none', borderRadius: '8px', padding: '8px 14px', cursor: 'pointer', flexShrink: 0,
};

const closeBtn: React.CSSProperties = {
  background: 'transparent', color: '#aaa', fontSize: '14px', fontWeight: 700,
  border: 'none', cursor: 'pointer', flexShrink: 0, padding: '4px 6px',
};
