'use client';

import React, { useEffect, useState } from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// Configuración de caja (Etapa 5) — solo admin.
//   1) WhatsApp del agente: número internacional sin "+" (ej 5491112345678) que
//      usa el operador para el link wa.me al "Descargar al agente".
//   2) Sueldo diario por operador: editable; lo cobra el operador desde Mi Caja.
// ─────────────────────────────────────────────────────────────────────────────

const fmt = (n: number) => n.toLocaleString('es-AR');

type Agent = { id: string; name: string; username: string; role: string; sueldo_diario: number | null };

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

  const [agents, setAgents]   = useState<Agent[] | null>(null);
  const [editId, setEditId]   = useState<string | null>(null);
  const [sueldoVal, setSueldoVal] = useState('');
  const [rowBusy, setRowBusy] = useState(false);
  const [error, setError]     = useState('');

  async function loadAll() {
    try {
      const [waRes, agRes] = await Promise.all([
        fetch('/api/settings/whatsapp-agente'),
        fetch('/api/agents'),
      ]);
      if (waRes.ok) {
        const d = await waRes.json();
        setWhatsapp(d.whatsapp_agente ?? '');
        setWaInitial(d.whatsapp_agente ?? '');
      }
      if (agRes.ok) {
        const list = (await agRes.json()) as Agent[];
        setAgents(Array.isArray(list) ? list : []);
      } else {
        setAgents([]);
      }
    } catch {
      setAgents([]);
    }
  }

  useEffect(() => { loadAll(); }, []);

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

  async function saveSueldo(id: string) {
    const n = parseInt(sueldoVal.replace(/\D/g, ''), 10);
    if (!Number.isInteger(n) || n < 0) { setError('Ingresá un sueldo válido (entero ≥ 0)'); return; }
    setRowBusy(true); setError('');
    try {
      const res = await fetch(`/api/agents/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sueldo_diario: n }),
      });
      if (!res.ok) { setError((await res.json().catch(() => ({})))?.error || 'No se pudo guardar el sueldo'); return; }
      setAgents((prev) => prev?.map((a) => (a.id === id ? { ...a, sueldo_diario: n } : a)) ?? null);
      setEditId(null);
    } catch {
      setError('Error de red');
    } finally {
      setRowBusy(false);
    }
  }

  const operadores = (agents ?? []).filter((a) => a.role === 'operator');
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

      {/* Sueldo diario por operador */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <p style={{ margin: 0, fontSize: '14px', fontWeight: 800, color: '#111' }}>Sueldo diario por operador</p>
        {agents === null ? (
          <p style={{ color: '#999', fontSize: '13px' }}>Cargando operadores…</p>
        ) : operadores.length === 0 ? (
          <p style={{ color: '#bbb', fontSize: '13px' }}>No hay operadores cargados.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {operadores.map((a) => {
              const editing = editId === a.id;
              return (
                <div key={a.id} style={{ background: '#fff', borderRadius: '12px', padding: '10px 14px', boxShadow: '0 1px 5px rgba(0,0,0,0.05)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '13px', fontWeight: 700, color: '#222' }}>
                    {a.name} <span style={{ fontSize: '11px', color: '#aaa' }}>@{a.username}</span>
                  </span>
                  {editing ? (
                    <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                      <input
                        type="number" min="0" step="1" value={sueldoVal} autoFocus
                        onChange={(e) => setSueldoVal(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') saveSueldo(a.id); if (e.key === 'Escape') setEditId(null); }}
                        style={{ ...inputStyle, width: '130px', padding: '6px 10px', fontSize: '13px' }}
                      />
                      <button onClick={() => saveSueldo(a.id)} disabled={rowBusy} style={{ ...btn('#C8FF00', '#000'), padding: '6px 12px' }}>OK</button>
                      <button onClick={() => setEditId(null)} style={{ ...btn('#F0F0F0', '#888'), padding: '6px 12px' }}>✕</button>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                      <span style={{ fontSize: '15px', fontWeight: 800, color: '#111' }}>${fmt(Number(a.sueldo_diario ?? 0))}</span>
                      <button onClick={() => { setEditId(a.id); setSueldoVal(String(a.sueldo_diario ?? 0)); setError(''); }} style={btn('#F0F0F0', '#333')}>Editar</button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
