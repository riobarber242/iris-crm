'use client';

import React, { useEffect, useState } from 'react';
import { SectionCard } from '@/components/ui/SectionCard';
import { playPendingSound, VOLUME_KEY, DEFAULT_VOLUME } from '@/lib/notify-sound';

// Slider de volumen del sonido de notificaciones (agent + operator). El valor
// (0..100) se guarda en localStorage y lo lee notify-sound.ts antes de sonar.
export default function NotificationVolumeCard() {
  const [vol, setVol] = useState(DEFAULT_VOLUME);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(VOLUME_KEY);
      const n = raw == null ? DEFAULT_VOLUME : Number(raw);
      setVol(Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : DEFAULT_VOLUME);
    } catch { /* localStorage no disponible: queda el default */ }
  }, []);

  function onChange(v: number) {
    setVol(v);
    try { localStorage.setItem(VOLUME_KEY, String(v)); } catch {}
  }

  return (
    <SectionCard title="Sonido de notificaciones" description="Volumen del aviso sonoro cuando entra un pendiente nuevo. Se guarda en este dispositivo.">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          <span style={{ fontSize: '18px' }}>{vol === 0 ? '🔇' : '🔊'}</span>
          <input
            type="range" min={0} max={100} step={1} value={vol}
            onChange={(e) => onChange(Number(e.target.value))}
            style={{ flex: 1, accentColor: '#1a1a1a' }}
          />
          <span style={{ fontSize: '14px', fontWeight: 800, width: '42px', textAlign: 'right' }}>{vol}</span>
        </div>
        <button
          type="button"
          onClick={() => playPendingSound('orange')}
          style={{ alignSelf: 'flex-start', background: '#C8FF00', color: '#000', fontWeight: 800, fontSize: '13px', border: 'none', borderRadius: '10px', padding: '9px 16px', cursor: 'pointer' }}
        >
          Probar
        </button>
      </div>
    </SectionCard>
  );
}
