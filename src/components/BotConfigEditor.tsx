"use client";

import React, { useEffect, useState } from 'react';

const IRIS_ORANGE = '#FF5500';
const MAX_LEN = 4000;

export default function BotConfigEditor() {
  const [prompt,       setPrompt]       = useState('');
  const [original,     setOriginal]     = useState('');
  const [defaultPrompt, setDefaultPrompt] = useState('');
  const [loading,      setLoading]      = useState(true);
  const [saving,       setSaving]       = useState(false);
  const [restoring,    setRestoring]    = useState(false);
  const [saved,        setSaved]        = useState(false);
  const [error,        setError]        = useState('');

  useEffect(() => {
    fetch('/api/agent/config')
      .then((r) => { if (!r.ok) throw new Error(); return r.json(); })
      .then((d) => {
        setPrompt(d.prompt ?? '');
        setOriginal(d.prompt ?? '');
        setDefaultPrompt(d.default ?? '');
      })
      .catch(() => setError('No se pudo cargar el system prompt.'))
      .finally(() => setLoading(false));
  }, []);

  async function save(value: string) {
    const res = await fetch('/api/agent/config', {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ prompt: value }),
    });
    if (!res.ok) throw new Error((await res.text()) || 'Error al guardar.');
  }

  async function handleSave() {
    setSaving(true); setSaved(false); setError('');
    try {
      await save(prompt);
      setOriginal(prompt);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err: any) {
      setError(err.message ?? 'Error al guardar.');
    }
    setSaving(false);
  }

  async function handleRestore() {
    if (!defaultPrompt) return;
    const ok = window.confirm(
      '¿Restaurar el system prompt por defecto? Se perderán tus cambios personalizados.'
    );
    if (!ok) return;
    setRestoring(true); setSaved(false); setError('');
    try {
      await save(defaultPrompt);
      setPrompt(defaultPrompt);
      setOriginal(defaultPrompt);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err: any) {
      setError(err.message ?? 'Error al restaurar.');
    }
    setRestoring(false);
  }

  const isDirty   = prompt !== original;
  const len       = prompt.length;
  const tooLong   = len > MAX_LEN;
  const isEmpty   = prompt.trim().length === 0;
  const busy      = saving || restoring;
  const canSave   = isDirty && !busy && !tooLong && !isEmpty;

  if (loading) return (
    <div style={{ padding: '16px', color: '#bbb', fontSize: '14px' }}>Cargando system prompt...</div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <p style={{ fontSize: '13px', color: '#555', margin: '0 0 6px 0' }}>
        Definí cómo se comporta tu asistente automático con tus clientes.
      </p>

      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={14}
        disabled={busy}
        placeholder="Escribí las instrucciones de tu bot..."
        style={{
          width: '100%',
          background: '#F5F5F5',
          border: tooLong ? '2px solid #E53935' : isDirty ? `2px solid ${IRIS_ORANGE}` : '2px solid transparent',
          borderRadius: '12px', padding: '14px 16px', fontSize: '13px', color: '#000',
          outline: 'none', resize: 'vertical', fontFamily: 'monospace', lineHeight: 1.6,
          boxSizing: 'border-box', transition: 'border-color 0.2s',
        }}
      />

      {/* Contador de caracteres, abajo a la derecha */}
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
          {saving ? 'Guardando...' : 'Guardar cambios'}
        </button>

        <button
          onClick={handleRestore}
          disabled={busy || !defaultPrompt}
          style={{
            background: '#EDEDED', color: '#555', fontWeight: 700, fontSize: '13px',
            border: 'none', borderRadius: '10px', padding: '10px 18px',
            cursor: busy || !defaultPrompt ? 'not-allowed' : 'pointer',
            opacity: busy || !defaultPrompt ? 0.6 : 1,
          }}
        >
          {restoring ? 'Restaurando...' : 'Restaurar por defecto'}
        </button>

        {saved && <span style={{ fontSize: '13px', color: '#1a7a3a', fontWeight: 700 }}>✅ Guardado</span>}
        {tooLong && !error && (
          <span style={{ fontSize: '13px', color: '#E53935', fontWeight: 700 }}>
            Supera el máximo de {MAX_LEN} caracteres
          </span>
        )}
        {error && <span style={{ fontSize: '13px', color: '#E53935', fontWeight: 700 }}>{error}</span>}
      </div>
    </div>
  );
}
