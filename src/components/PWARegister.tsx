'use client';

import { useEffect, useState } from 'react';
import { useAuth } from './AuthProvider';

// Convierte la VAPID public key (base64url) a Uint8Array para pushManager.subscribe.
function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// Registra el service worker, gestiona el aviso de "nueva versión" y suscribe al
// push (solo cuando hay un agente logueado, porque guardamos la sub por agente).
export default function PWARegister() {
  const { agent } = useAuth();
  const [waitingWorker, setWaitingWorker] = useState<ServiceWorker | null>(null);

  // ── Registro del SW + detección de versión nueva ──────────────────────────
  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;

    let reloaded = false;

    navigator.serviceWorker.register('/sw.js').then((registration) => {
      console.log('[PWA] SW registrado:', registration.scope);

      // Ya había una versión esperando al cargar la página.
      if (registration.waiting && navigator.serviceWorker.controller) {
        setWaitingWorker(registration.waiting);
      }

      // Una versión nueva empezó a instalarse mientras la app está abierta.
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

    // Cuando el SW nuevo toma control (tras SKIP_WAITING) → recargar una vez.
    const onControllerChange = () => {
      if (reloaded) return;
      reloaded = true;
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
    return () => navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
  }, []);

  // ── Push: pedir permiso y suscribir (depende del agente logueado) ─────────
  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;

    let cancelled = false;

    (async () => {
      try {
        console.log('[PWA] agent:', agent?.id ?? 'null');
        if (!agent) return;
        if (!('PushManager' in window) || !('Notification' in window)) return;

        const vapidKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
        console.log('[PWA] vapidKey presente:', !!vapidKey);
        if (!vapidKey) {
          console.warn('[pwa] NEXT_PUBLIC_VAPID_PUBLIC_KEY no configurada — sin push');
          return;
        }

        console.log('[PWA] Notification.permission:', Notification.permission);
        let permission = Notification.permission;
        if (permission === 'default') permission = await Notification.requestPermission();
        if (permission !== 'granted' || cancelled) return;

        const registration = await navigator.serviceWorker.ready;

        const existing = await registration.pushManager.getSubscription();
        const subscription = existing ?? await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapidKey),
        });

        if (cancelled) return;

        await fetch('/api/push/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subscription, agentId: agent.id }),
        });
      } catch (err) {
        console.warn('[pwa] Error suscribiendo push:', err);
      }
    })();

    return () => { cancelled = true; };
  }, [agent]);

  function applyUpdate() {
    waitingWorker?.postMessage({ type: 'SKIP_WAITING' });
    setWaitingWorker(null);
  }

  if (!waitingWorker) return null;

  return (
    <div
      style={{
        position: 'fixed', bottom: '16px', left: '50%', transform: 'translateX(-50%)',
        zIndex: 9999, background: '#1a1a1a', color: '#fff',
        borderRadius: '12px', padding: '10px 12px 10px 16px',
        display: 'flex', alignItems: 'center', gap: '12px',
        boxShadow: '0 6px 24px rgba(0,0,0,0.32)', maxWidth: 'calc(100vw - 32px)',
      }}
      role="status"
    >
      <span style={{ fontSize: '14px' }}>Hay una nueva versión disponible</span>
      <button
        onClick={applyUpdate}
        style={{
          background: '#C8FF00', color: '#000', fontWeight: 700, fontSize: '14px',
          border: 'none', borderRadius: '8px', padding: '8px 14px', cursor: 'pointer',
          flexShrink: 0,
        }}
      >
        Actualizar
      </button>
    </div>
  );
}
