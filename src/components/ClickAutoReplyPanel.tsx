'use client';

// Panel de configuración del auto-enganche al click de botón de plantilla, dentro
// de la sección de Campañas. Switch on/off + un mensaje por POSICIÓN de botón
// (primero = positivo, último = negativo) + plantilla de fallback opcional por
// posición. El texto se conserva aunque se apague el switch.

import React, { useEffect, useState } from 'react';
import { DEFAULT_POSITIVE, DEFAULT_NEGATIVE, MAX_BUTTONS } from '@/lib/campaigns/click-autoreply';

type Row = { text: string; fallback_template: string };

const cardStyle: React.CSSProperties = {
  background: '#fff', borderRadius: '16px', padding: '16px 22px',
  boxShadow: '0 2px 12px rgba(0,0,0,0.08)', display: 'flex', flexDirection: 'column', gap: '14px',
};
const labelStyle: React.CSSProperties = { fontSize: '11px', fontWeight: 800, color: '#888', textTransform: 'uppercase', letterSpacing: '0.03em' };

// Etiqueta y placeholder de cada posición. El default (positivo/negativo) aplica al
// PRIMER y ÚLTIMO botón de la plantilla; las posiciones del medio requieren texto.
function rowMeta(i: number, total: number) {
  if (i === 0) return { title: 'Botón positivo (primero)', ph: DEFAULT_POSITIVE };
  if (i === total - 1) return { title: 'Botón negativo (último)', ph: DEFAULT_NEGATIVE };
  return { title: `Botón ${i + 1} (intermedio)`, ph: 'Escribí el mensaje para este botón (las posiciones intermedias no tienen texto por defecto).' };
}

export default function ClickAutoReplyPanel() {
  const [open,    setOpen]    = useState(false);
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [rows,    setRows]    = useState<Row[]>([{ text: '', fallback_template: '' }, { text: '', fallback_template: '' }]);
  const [saving,  setSaving]  = useState(false);
  const [savedAt, setSavedAt] = useState(false);
  const [error,   setError]   = useState('');

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/campaigns/autoreply', { cache: 'no-store' });
        if (r.ok) {
          const d = await r.json();
          setEnabled(!!d?.enabled);
          const msgs: Row[] = Array.isArray(d?.messages)
            ? d.messages.map((m: any) => ({ text: String(m?.text ?? ''), fallback_template: String(m?.fallback_template ?? '') }))
            : [];
          // Mínimo 2 posiciones visibles (positivo + negativo) aunque no haya nada guardado.
          while (msgs.length < 2) msgs.push({ text: '', fallback_template: '' });
          setRows(msgs);
        }
      } catch { /* deja los defaults del estado */ }
      setLoading(false);
    })();
  }, []);

  function patchRow(i: number, patch: Partial<Row>) {
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
    setSavedAt(false);
  }
  function addRow() {
    setRows((rs) => (rs.length >= MAX_BUTTONS ? rs : [...rs, { text: '', fallback_template: '' }]));
    setSavedAt(false);
  }
  function removeRow(i: number) {
    // No se pueden quitar las 2 primeras (positivo/negativo del caso base).
    setRows((rs) => (rs.length <= 2 ? rs : rs.filter((_, j) => j !== i)));
    setSavedAt(false);
  }

  async function save() {
    setSaving(true); setError('');
    try {
      const r = await fetch('/api/campaigns/autoreply', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, messages: rows }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => null);
        setError(d?.error || (r.status === 403 ? 'No tenés permiso para editar esto.' : 'No se pudo guardar.'));
      } else {
        setSavedAt(true);
      }
    } catch {
      setError('No se pudo guardar.');
    }
    setSaving(false);
  }

  return (
    <div style={cardStyle}>
      {/* Encabezado + switch (siempre visible, aunque el panel esté colapsado) */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
        <button
          onClick={() => setOpen((o) => !o)}
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px', padding: 0, textAlign: 'left' }}
        >
          <span style={{ fontSize: '14px', color: '#888', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>▸</span>
          <div>
            <span style={{ fontSize: '14px', fontWeight: 800, color: '#000' }}>🤖 Auto-respuestas al click de botón</span>
            <p style={{ fontSize: '12px', color: '#999', margin: '2px 0 0 0' }}>
              Responde al instante cuando un contacto aprieta un botón de la plantilla — abre la conversación sin esperar al operador.
            </p>
          </div>
        </button>

        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', whiteSpace: 'nowrap' }}>
          <span style={{ fontSize: '12px', fontWeight: 700, color: enabled ? '#1a7a3a' : '#999' }}>{enabled ? 'Activo' : 'Inactivo'}</span>
          <span
            onClick={() => { setEnabled((e) => !e); setSavedAt(false); }}
            style={{ width: '42px', height: '24px', borderRadius: '12px', background: enabled ? '#22c55e' : '#ccc', position: 'relative', transition: 'background 0.15s', flexShrink: 0 }}
          >
            <span style={{ position: 'absolute', top: '2px', left: enabled ? '20px' : '2px', width: '20px', height: '20px', borderRadius: '50%', background: '#fff', transition: 'left 0.15s' }} />
          </span>
        </label>
      </div>

      {open && !loading && (
        <>
          <p style={{ fontSize: '12px', color: '#aaa', margin: 0, lineHeight: 1.5 }}>
            La posición manda: el <strong>primer</strong> botón es el positivo y el <strong>último</strong> el negativo (no depende del texto del botón).
            Si dejás un campo vacío se usa un mensaje por defecto. Solo aplica a plantillas <strong>con botones</strong>.
          </p>

          {rows.map((row, i) => {
            const meta = rowMeta(i, rows.length);
            return (
              <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: '6px', borderTop: i === 0 ? 'none' : '1px solid #f0f0f0', paddingTop: i === 0 ? 0 : '12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={labelStyle}>{meta.title}</span>
                  {i >= 2 && (
                    <button onClick={() => removeRow(i)} style={{ background: 'transparent', border: 'none', color: '#E53935', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}>
                      ✕ Quitar
                    </button>
                  )}
                </div>
                <textarea
                  value={row.text}
                  onChange={(e) => patchRow(i, { text: e.target.value })}
                  placeholder={meta.ph}
                  rows={3}
                  style={{ width: '100%', resize: 'vertical', padding: '10px 12px', borderRadius: '10px', border: '1px solid #e5e5e5', fontSize: '13px', fontFamily: 'inherit', boxSizing: 'border-box' }}
                />
                <input
                  value={row.fallback_template}
                  onChange={(e) => patchRow(i, { fallback_template: e.target.value })}
                  placeholder="Plantilla de respaldo (opcional) — nombre exacto en Meta, se usa si la ventana está cerrada"
                  style={{ width: '100%', padding: '8px 12px', borderRadius: '10px', border: '1px solid #e5e5e5', fontSize: '12px', fontFamily: 'inherit', boxSizing: 'border-box' }}
                />
              </div>
            );
          })}

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
            <button
              onClick={addRow}
              disabled={rows.length >= MAX_BUTTONS}
              style={{ background: 'transparent', color: rows.length >= MAX_BUTTONS ? '#ccc' : '#1a1a1a', fontWeight: 700, fontSize: '12px', border: '1px dashed #ccc', borderRadius: '10px', padding: '8px 14px', cursor: rows.length >= MAX_BUTTONS ? 'not-allowed' : 'pointer' }}
            >
              + Agregar botón
            </button>

            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              {error && <span style={{ fontSize: '12px', color: '#E53935' }}>{error}</span>}
              {savedAt && !error && <span style={{ fontSize: '12px', color: '#1a7a3a', fontWeight: 700 }}>✓ Guardado</span>}
              <button
                onClick={save}
                disabled={saving}
                style={{ background: '#1a1a1a', color: '#C8FF00', fontWeight: 800, fontSize: '13px', border: 'none', borderRadius: '12px', padding: '10px 22px', cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.6 : 1 }}
              >
                {saving ? 'Guardando…' : 'Guardar'}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
