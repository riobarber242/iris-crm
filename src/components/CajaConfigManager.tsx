'use client';

import React, { useEffect, useState } from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// Configuración de caja (Etapa 5) — solo admin.
//   WhatsApp del agente: número internacional sin "+" (ej 5491112345678) que usa
//   el operador para el link wa.me al "Descargar al agente".
//   (El sueldo diario por operador se edita ahora desde Agentes.)
// ─────────────────────────────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  padding: '10px 12px', border: '2px solid #eee', borderRadius: '10px',
  fontSize: '14px', fontWeight: 700, outline: 'none', background: '#F7F7F7',
};
const btn = (bg: string, fg: string): React.CSSProperties => ({
  background: bg, color: fg, fontWeight: 800, fontSize: '13px', border: 'none',
  borderRadius: '10px', padding: '9px 16px', cursor: 'pointer',
});

export default function CajaConfigManager() {
  const [whatsapp, setWhatsapp]   = useState('');
  const [waInitial, setWaInitial] = useState('');
  const [waBusy, setWaBusy]       = useState(false);
  const [waMsg, setWaMsg]         = useState<string | null>(null);
  const [error, setError]         = useState('');

  async function loadWhatsapp() {
    try {
      const waRes = await fetch('/api/settings/whatsapp-agente');
      if (waRes.ok) {
        const d = await waRes.json();
        setWhatsapp(d.whatsapp_agente ?? '');
        setWaInitial(d.whatsapp_agente ?? '');
      }
    } catch { /* sin datos: queda vacío */ }
  }

  useEffect(() => { loadWhatsapp(); }, []);

  async function saveWhatsapp() {
    setWaBusy(true); setWaMsg(null); setError('');
    try {
      const res = await fetch('/api/settings/whatsapp-agente', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ whatsapp_agente: whatsapp }),
      });
      if (!res.ok) { setError((await res.json().catch(() => ({})))?.error || 'No se pudo guardar'); return; }
      const d = await res.json();
      setWhatsapp(d.whatsapp_agente ?? '');
      setWaInitial(d.whatsapp_agente ?? '');
      setWaMsg('Guardado.');
    } catch {
      setError('Error de red');
    } finally {
      setWaBusy(false);
    }
  }

  const waDirty = whatsapp.trim() !== waInitial.trim();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '22px' }}>
      {error && (
        <div style={{ background: '#FFE5E5', color: '#CC3333', borderRadius: '10px', padding: '10px 14px', fontSize: '13px', fontWeight: 600 }}>
          {error}
        </div>
      )}

      {/* WhatsApp del agente */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <p style={{ margin: 0, fontSize: '14px', fontWeight: 800, color: '#111' }}>WhatsApp del agente</p>
        <p style={{ margin: 0, fontSize: '12px', color: '#999' }}>
          Número internacional sin “+”, ejemplo <code>5491112345678</code>. Lo usa el operador al descargar.
        </p>
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            value={whatsapp}
            onChange={(e) => { setWhatsapp(e.target.value); setWaMsg(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter' && waDirty) saveWhatsapp(); }}
            placeholder="5491112345678" inputMode="numeric"
            style={{ ...inputStyle, flex: 1, minWidth: '200px' }}
          />
          <button onClick={saveWhatsapp} disabled={waBusy || !waDirty} style={{ ...btn('#C8FF00', '#000'), opacity: waDirty ? 1 : 0.5, cursor: waDirty && !waBusy ? 'pointer' : 'not-allowed' }}>
            {waBusy ? '…' : 'Guardar'}
          </button>
          {waMsg && <span style={{ fontSize: '13px', fontWeight: 700, color: '#1a7a3a' }}>✓ {waMsg}</span>}
        </div>
      </div>
    </div>
  );
}
