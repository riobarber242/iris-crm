'use client';

import { useEffect } from 'react';
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

// Registra el service worker, pide permiso de notificaciones y suscribe al push.
// Solo corre cuando hay un agente logueado (necesitamos su id para guardar la sub).
export default function PWARegister() {
  const { agent } = useAuth();

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!('serviceWorker' in navigator)) return;

    let cancelled = false;

    (async () => {
      try {
        const registration = await navigator.serviceWorker.register('/sw.js');

        // Sin agente logueado: registramos el SW pero no suscribimos al push.
        if (!agent) return;
        if (!('PushManager' in window) || !('Notification' in window)) return;

        const vapidKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
        if (!vapidKey) {
          console.warn('[pwa] NEXT_PUBLIC_VAPID_PUBLIC_KEY no configurada — sin push');
          return;
        }

        // Pedir permiso solo si el usuario aún no decidió.
        let permission = Notification.permission;
        if (permission === 'default') permission = await Notification.requestPermission();
        if (permission !== 'granted' || cancelled) return;

        await navigator.serviceWorker.ready;

        // Reusar suscripción existente o crear una nueva.
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
        console.warn('[pwa] Error registrando SW / push:', err);
      }
    })();

    return () => { cancelled = true; };
  }, [agent]);

  return null;
}
