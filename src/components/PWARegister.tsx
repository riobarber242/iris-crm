'use client';

import { useEffect, useState, useCallback } from 'react';
import { useAuth } from './AuthProvider';
import { fetchWithTimeout } from '@/lib/fetchWithTimeout';

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
  const [waitingWorker, setWaitingWorker] = useState<ServiceWorker | null>(null);
  const [pushPrompt, setPushPrompt] = useState<PushPrompt>(null);
  const [dismissed, setDismissed] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const vapidKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;

  // ── Registro del SW + detección de versión nueva ──────────────────────────
  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;

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
  const ensureSubscription = useCallback(async () => {
    if (!agent || !vapidKey) return;
    const registration = await withTimeout(
      navigator.serviceWorker.ready, 12000, 'service worker listo',
    );
    const existing = await registration.pushManager.getSubscription();
    const subscription = existing ?? await withTimeout(
      registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey),
      }),
      12000, 'suscripción push',
    );
    const res = await fetchWithTimeout('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription, agentId: agent.id }),
    }, 15000);
    if (!res.ok) throw new Error(`El servidor rechazó la suscripción (HTTP ${res.status})`);
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
        setError('Bloqueaste las notificaciones. Activalas desde el candado del navegador y recargá.');
      } else {
        // 'default' → cerró el prompt sin decidir. Dejamos el banner para reintentar.
        setError('No se completó la activación. Probá de nuevo.');
      }
    } catch (err) {
      console.warn('[pwa] Error activando notificaciones:', err);
      setError('No se pudieron activar las notificaciones. Reintentá.');
    } finally {
      setWorking(false);
    }
  }

  function applyUpdate() {
    waitingWorker?.postMessage({ type: 'SKIP_WAITING' });
    setWaitingWorker(null);
  }

  const showPush = pushPrompt !== null && !dismissed;
  if (!waitingWorker && !showPush) return null;

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
