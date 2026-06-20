'use client';

// Sonido de notificación de pendientes nuevos: un "ding" real
// (public/sounds/notification.wav), estilo mensaje entrante.
//  · naranja → un ding.
//  · rojo    → doble ding (más urgente).
// El volumen sale de localStorage (clave iris_notif_volume, 0..100), que ajusta
// el slider de Configuración. Best-effort: la política de autoplay del navegador
// puede bloquearlo hasta que haya interacción del usuario.

const SOUND_URL = '/sounds/notification.wav';
export const VOLUME_KEY = 'iris_notif_volume'; // 0..100
export const DEFAULT_VOLUME = 80;

// Precarga el archivo (calienta la cache del navegador). No se reproduce.
const preload = typeof window !== 'undefined' ? new Audio(SOUND_URL) : null;
if (preload) preload.preload = 'auto';

function readVolume(): number {
  try {
    const raw = localStorage.getItem(VOLUME_KEY);
    if (raw == null) return DEFAULT_VOLUME;
    const n = Number(raw);
    if (!Number.isFinite(n)) return DEFAULT_VOLUME;
    return Math.min(100, Math.max(0, n));
  } catch {
    return DEFAULT_VOLUME;
  }
}

// Una instancia nueva por reproducción → permite solapar el doble ding del rojo.
// El archivo ya quedó cacheado por el preload, así que no hay descarga repetida.
function playOnce(vol: number) {
  if (typeof window === 'undefined') return;
  try {
    const a = new Audio(SOUND_URL);
    a.volume = Math.min(1, Math.max(0, vol / 100));
    a.play().catch(() => {});
  } catch {}
}

export function playPendingSound(kind: 'orange' | 'red') {
  const vol = readVolume();
  if (vol <= 0) return; // muteado
  playOnce(vol);
  if (kind === 'red') {
    setTimeout(() => playOnce(vol), 220); // segundo ding, solapado: urgencia
  }
}
