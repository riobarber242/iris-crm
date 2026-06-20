"use client";

import React, { useEffect, useState } from 'react';
import { renderAutoMsg, AUTO_MSG_MAX_LEN, AUTO_MSG_DEFAULT_TEMPLATE } from '@/lib/auto-msg';

export default function AutoMsgToggle() {
  const [enabled,  setEnabled]  = useState<boolean>(false);
  const [loading,  setLoading]  = useState(false);
  const [ready,    setReady]    = useState(false); // GET inicial resuelto

  // Template editable.
  const [template,    setTemplate]    = useState(AUTO_MSG_DEFAULT_TEMPLATE);
  const [tplInitial,  setTplInitial]  = useState(AUTO_MSG_DEFAULT_TEMPLATE);
  const [savingTpl,   setSavingTpl]   = useState(false);
  const [tplMsg,      setTplMsg]      = useState<string | null>(null);
  const [tplErr,      setTplErr]      = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/settings/auto-verificacion')
      .then((r) => r.json())
      .then((d) => {
        setEnabled(d.enabled);
        if (typeof d.template === 'string' && d.template) {
          setTemplate(d.template);
          setTplInitial(d.template);
        }
      })
      .catch(() => {})           // si falla, queda en default
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

  async function saveTemplate() {
    if (savingTpl) return;
    setSavingTpl(true); setTplMsg(null); setTplErr(null);
    try {
      const res = await fetch('/api/settings/auto-verificacion', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ template }),
      });
      if (!res.ok) { setTplErr((await res.text().catch(() => '')) || 'No se pudo guardar'); return; }
      setTplInitial(template);
      setTplMsg('Guardado.');
    } catch {
      setTplErr('Error de red');
    } finally {
      setSavingTpl(false);
    }
  }

  const tplDirty = template.trim() !== tplInitial.trim();
  const tplValido = !!template.trim() && template.length <= AUTO_MSG_MAX_LEN;
  const preview = renderAutoMsg(template, '15.000');

  return (
    <div style={{
      background: '#fff', borderRadius: '16px', padding: '20px 24px',
      boxShadow: '0 2px 10px rgba(0,0,0,0.07)',
      display: 'flex', flexDirection: 'column', gap: '18px',
    }}>
      {/* Fila superior: título + toggle on/off */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px' }}>
        <div>
          <p style={{ fontSize: '15px', fontWeight: 800, color: '#000', margin: 0 }}>
            Notificación automática al verificar
          </p>
          <p style={{ fontSize: '13px', color: '#999', margin: '4px 0 0 0' }}>
            {!ready
              ? 'Cargando configuración…'
              : enabled
              ? 'Al verificar una recarga se envía el mensaje de abajo por WhatsApp.'
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
            minWidth: '130px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', flexShrink: 0,
          }}
        >
          <span style={{ width: '10px', height: '10px', borderRadius: '50%', background: !ready ? '#bbb' : enabled ? '#3a7a00' : '#888', display: 'inline-block', flexShrink: 0 }} />
          {!ready ? '…' : loading ? '...' : enabled ? 'Activado' : 'Desactivado'}
        </button>
      </div>

      {/* Editor del mensaje */}
      <div style={{ borderTop: '1px solid #eee', paddingTop: '16px', display: 'flex', flexDirection: 'column', gap: '8px', opacity: enabled ? 1 : 0.6 }}>
        <label style={{ fontSize: '13px', fontWeight: 800, color: '#333' }}>Mensaje</label>
        <p style={{ fontSize: '12px', color: '#999', margin: 0 }}>
          Usá <code style={{ background: '#f0f0f0', padding: '1px 5px', borderRadius: '5px' }}>$monto</code> para el importe (ej. <strong>$15.000</strong>).
        </p>
        <textarea
          value={template}
          onChange={(e) => { setTemplate(e.target.value); setTplMsg(null); setTplErr(null); }}
          rows={3}
          maxLength={AUTO_MSG_MAX_LEN}
          disabled={!ready}
          placeholder={AUTO_MSG_DEFAULT_TEMPLATE}
          style={{ padding: '11px 13px', border: '2px solid #eee', borderRadius: '10px', fontSize: '14px', fontWeight: 600, outline: 'none', background: '#F7F7F7', resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }}
        />
        <div style={{ background: '#F0FFF4', border: '1px solid #cdeed6', borderRadius: '10px', padding: '10px 12px', fontSize: '13px', color: '#1a7a3a' }}>
          <span style={{ fontWeight: 800 }}>Vista previa:</span> {preview}
        </div>
        {tplErr && <div style={{ background: '#FFE5E5', color: '#CC3333', borderRadius: '10px', padding: '8px 12px', fontSize: '13px', fontWeight: 600 }}>{tplErr}</div>}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <button
            onClick={saveTemplate}
            disabled={savingTpl || !ready || !tplDirty || !tplValido}
            style={{ background: '#C8FF00', color: '#000', fontWeight: 800, fontSize: '13px', border: 'none', borderRadius: '10px', padding: '9px 18px', cursor: (savingTpl || !tplDirty || !tplValido) ? 'not-allowed' : 'pointer', opacity: (tplDirty && tplValido) ? 1 : 0.5, alignSelf: 'flex-start' }}
          >
            {savingTpl ? '…' : 'Guardar mensaje'}
          </button>
          {tplMsg && <span style={{ fontSize: '13px', fontWeight: 700, color: '#1a7a3a' }}>✓ {tplMsg}</span>}
        </div>
      </div>
    </div>
  );
}
