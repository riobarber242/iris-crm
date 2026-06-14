"use client";

import React, { useEffect, useState } from 'react';

export default function AutoMsgToggle() {
  const [enabled,  setEnabled]  = useState<boolean>(false);
  const [loading,  setLoading]  = useState(false);
  const [ready,    setReady]    = useState(false); // GET inicial resuelto

  useEffect(() => {
    fetch('/api/settings/auto-verificacion')
      .then((r) => r.json())
      .then((d) => setEnabled(d.enabled))
      .catch(() => {})           // si falla, queda en false por defecto
      .finally(() => setReady(true));
  }, []);

  async function toggle() {
    if (loading) return;
    setLoading(true);
    const next = !enabled;
    try {
      const res = await fetch('/api/settings/auto-verificacion', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ enabled: next }),
      });
      if (res.ok) setEnabled(next);
    } catch {}
    setLoading(false);
  }

  return (
    <div style={{
      background: '#fff', borderRadius: '16px', padding: '20px 24px',
      boxShadow: '0 2px 10px rgba(0,0,0,0.07)',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px',
    }}>
      <div>
        <p style={{ fontSize: '15px', fontWeight: 800, color: '#000', margin: 0 }}>
          Notificación automática al verificar
        </p>
        <p style={{ fontSize: '13px', color: '#999', margin: '4px 0 0 0' }}>
          {!ready
            ? 'Cargando configuración…'
            : enabled
            ? 'Al verificar un comprobante se envía "Tu recarga de $X fue confirmada ✅" por WhatsApp.'
            : 'La notificación automática está desactivada. El cliente no recibe mensaje al verificar.'}
        </p>
      </div>
      <button
        onClick={toggle}
        disabled={loading || !ready}
        style={{
          background: !ready ? '#EAEAEA' : enabled ? '#C8FF00' : '#1a1a1a',
          color:      !ready ? '#999'    : enabled ? '#000'    : '#fff',
          fontWeight: 800, fontSize: '14px', border: 'none',
          borderRadius: '999px', padding: '10px 20px',
          cursor: loading || !ready ? 'not-allowed' : 'pointer',
          opacity: loading ? 0.6 : 1, transition: 'all 0.2s',
          minWidth: '130px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
        }}
      >
        <span style={{ width: '10px', height: '10px', borderRadius: '50%', background: !ready ? '#bbb' : enabled ? '#3a7a00' : '#888', display: 'inline-block', flexShrink: 0 }} />
        {!ready ? '…' : loading ? '...' : enabled ? 'Activado' : 'Desactivado'}
      </button>
    </div>
  );
}
