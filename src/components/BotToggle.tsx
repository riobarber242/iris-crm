"use client";

import React, { useEffect, useState } from 'react';

export default function BotToggle() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch('/api/settings/bot-enabled')
      .then((r) => r.json())
      .then((d) => setEnabled(d.enabled))
      .catch(() => {});

    function handleChange(e: Event) {
      const detail = (e as CustomEvent).detail;
      if (typeof detail?.enabled === 'boolean') setEnabled(detail.enabled);
    }
    window.addEventListener('bot-status-changed', handleChange);
    return () => window.removeEventListener('bot-status-changed', handleChange);
  }, []);

  async function toggle() {
    if (enabled === null || loading) return;
    setLoading(true);
    const next = !enabled;
    try {
      const res = await fetch('/api/settings/bot-enabled', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ enabled: next }),
      });
      if (res.ok) {
        setEnabled(next);
        window.dispatchEvent(new CustomEvent('bot-status-changed', { detail: { enabled: next } }));
      }
    } catch {}
    setLoading(false);
  }

  if (enabled === null) {
    return (
      <div style={{ background: '#fff', borderRadius: '16px', padding: '20px 24px', boxShadow: '0 2px 10px rgba(0,0,0,0.07)' }}>
        <p style={{ color: '#bbb', fontSize: '14px', margin: 0 }}>Cargando estado del bot...</p>
      </div>
    );
  }

  return (
    <div style={{
      background: '#fff',
      borderRadius: '16px',
      padding: '20px 24px',
      boxShadow: '0 2px 10px rgba(0,0,0,0.07)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '16px',
    }}>
      <div>
        <p style={{ fontSize: '15px', fontWeight: 800, color: '#000', margin: 0 }}>
          Bot automático
        </p>
        <p style={{ fontSize: '13px', color: '#999', margin: '4px 0 0 0' }}>
          {enabled
            ? 'El bot responde mensajes nuevos automáticamente.'
            : 'El bot está pausado. Solo los operadores responden.'}
        </p>
      </div>

      <button
        onClick={toggle}
        disabled={loading}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          background: enabled ? '#C8FF00' : '#1a1a1a',
          color: enabled ? '#000' : '#fff',
          border: 'none',
          borderRadius: '999px',
          padding: '10px 20px',
          fontSize: '14px',
          fontWeight: 800,
          cursor: loading ? 'not-allowed' : 'pointer',
          opacity: loading ? 0.6 : 1,
          transition: 'all 0.2s',
          minWidth: '130px',
          justifyContent: 'center',
        }}
      >
        <span style={{
          width: '10px', height: '10px', borderRadius: '50%',
          background: enabled ? '#3a7a00' : '#888',
          display: 'inline-block',
          flexShrink: 0,
        }} />
        {loading ? '...' : enabled ? 'Encendido' : 'Apagado'}
      </button>
    </div>
  );
}
