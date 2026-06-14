"use client";

import React, { useEffect, useState } from 'react';

const IRIS_ORANGE = '#FF5500';
const MAX_LEN = 300;

// Modo offline del bot: toggle on/off + mensaje editable que ve el cliente.
// El toggle usa /api/settings/offline-mode (mismo endpoint que el header) y
// emite 'offline-mode-changed' para que el header se sincronice al instante.
// El mensaje usa /api/settings/offline-msg.
export default function OfflineConfig() {
  const [offline, setOffline] = useState<boolean | null>(null);
  const [toggling, setToggling] = useState(false);

  const [msg, setMsg]           = useState('');
  const [original, setOriginal] = useState('');
  const [loadingMsg, setLoadingMsg] = useState(true);
  const [saving, setSaving]     = useState(false);
  const [saved, setSaved]       = useState(false);
  const [error, setError]       = useState('');

  useEffect(() => {
    fetch('/api/settings/offline-mode')
      .then((r) => r.json())
      .then((d) => setOffline(!!d.offline))
      .catch(() => setOffline(false));

    fetch('/api/settings/offline-msg')
      .then((r) => r.json())
      .then((d) => { setMsg(d.msg ?? ''); setOriginal(d.msg ?? ''); })
      .catch(() => setError('No se pudo cargar el mensaje de offline.'))
      .finally(() => setLoadingMsg(false));
  }, []);

  async function toggle() {
    if (offline === null || toggling) return;
    setToggling(true);
    const next = !offline;
    setOffline(next);
    window.dispatchEvent(new CustomEvent('offline-mode-changed', { detail: { offline: next } }));
    try {
      const res = await fetch('/api/settings/offline-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offline: next }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setOffline(!next);
        window.dispatchEvent(new CustomEvent('offline-mode-changed', { detail: { offline: !next } }));
      }
    } catch {
      setOffline(!next);
      window.dispatchEvent(new CustomEvent('offline-mode-changed', { detail: { offline: !next } }));
    }
    setToggling(false);
  }

  async function handleSave() {
    setSaving(true); setSaved(false); setError('');
    try {
      const res = await fetch('/api/settings/offline-msg', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msg }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || 'Error al guardar.');
      setOriginal(msg);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err: any) {
      setError(err.message ?? 'Error al guardar.');
    }
    setSaving(false);
  }

  const isDirty = msg !== original;
  const len     = msg.length;
  const tooLong = len > MAX_LEN;
  const isEmpty = msg.trim().length === 0;
  const canSave = isDirty && !saving && !tooLong && !isEmpty;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
      {/* Toggle on/off */}
      <div style={{
        background: '#F5F5F5', borderRadius: '14px', padding: '16px 20px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px',
      }}>
        <div>
          <p style={{ fontSize: '15px', fontWeight: 800, color: '#000', margin: 0 }}>
            Modo offline
          </p>
          <p style={{ fontSize: '13px', color: '#999', margin: '4px 0 0 0' }}>
            {offline
              ? 'Activado: el bot responde a todos los clientes con el mensaje de abajo.'
              : 'Desactivado: el bot atiende normalmente.'}
          </p>
        </div>
        <button
          onClick={toggle}
          disabled={offline === null || toggling}
          style={{
            background: offline ? '#FF4444' : '#1a1a1a',
            color: '#fff', fontWeight: 800, fontSize: '14px', border: 'none',
            borderRadius: '999px', padding: '10px 20px',
            cursor: offline === null || toggling ? 'not-allowed' : 'pointer',
            opacity: offline === null || toggling ? 0.6 : 1, transition: 'all 0.2s',
            minWidth: '130px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
          }}
        >
          <span style={{ width: '10px', height: '10px', borderRadius: '50%', background: offline ? '#fff' : '#888', display: 'inline-block', flexShrink: 0 }} />
          {offline === null ? '...' : toggling ? '...' : offline ? 'Activado' : 'Desactivado'}
        </button>
      </div>

      {/* Mensaje editable */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <p style={{ fontSize: '13px', color: '#555', margin: '0 0 2px 0' }}>
          Mensaje que reciben los clientes mientras el modo offline esté activo.
        </p>

        {loadingMsg ? (
          <div style={{ padding: '16px', color: '#bbb', fontSize: '14px' }}>Cargando mensaje...</div>
        ) : (
          <>
            <textarea
              value={msg}
              onChange={(e) => setMsg(e.target.value)}
              rows={3}
              disabled={saving}
              placeholder="Hola! En este momento no estamos operando. Volvemos pronto 🙏"
              style={{
                width: '100%',
                background: '#F5F5F5',
                border: tooLong ? '2px solid #E53935' : isDirty ? `2px solid ${IRIS_ORANGE}` : '2px solid transparent',
                borderRadius: '12px', padding: '14px 16px', fontSize: '14px', color: '#000',
                outline: 'none', resize: 'vertical', lineHeight: 1.5,
                boxSizing: 'border-box', transition: 'border-color 0.2s',
              }}
            />

            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <span style={{ fontSize: '12px', fontWeight: 600, color: tooLong ? '#E53935' : '#999' }}>
                {len} / {MAX_LEN}
              </span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '4px', flexWrap: 'wrap' }}>
              <button
                onClick={handleSave}
                disabled={!canSave}
                style={{
                  background: canSave ? IRIS_ORANGE : '#e0e0e0',
                  color: canSave ? '#fff' : '#999',
                  fontWeight: 800, fontSize: '13px', border: 'none', borderRadius: '10px',
                  padding: '10px 22px', cursor: canSave ? 'pointer' : 'not-allowed',
                  transition: 'background 0.2s',
                }}
              >
                {saving ? 'Guardando...' : 'Guardar mensaje'}
              </button>

              {saved && <span style={{ fontSize: '13px', color: '#1a7a3a', fontWeight: 700 }}>✅ Guardado</span>}
              {tooLong && !error && (
                <span style={{ fontSize: '13px', color: '#E53935', fontWeight: 700 }}>
                  Supera el máximo de {MAX_LEN} caracteres
                </span>
              )}
              {error && <span style={{ fontSize: '13px', color: '#E53935', fontWeight: 700 }}>{error}</span>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
