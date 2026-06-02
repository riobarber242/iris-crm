"use client";

import React, { useEffect, useState } from 'react';

export default function SystemPromptEditor() {
  const [prompt,   setPrompt]   = useState('');
  const [original, setOriginal] = useState('');
  const [loading,  setLoading]  = useState(true);
  const [saving,   setSaving]   = useState(false);
  const [saved,    setSaved]    = useState(false);
  const [error,    setError]    = useState('');

  useEffect(() => {
    fetch('/api/settings/system-prompt')
      .then((r) => r.json())
      .then((d) => { setPrompt(d.prompt); setOriginal(d.prompt); })
      .catch(() => setError('No se pudo cargar el prompt.'))
      .finally(() => setLoading(false));
  }, []);

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    setError('');
    try {
      const res = await fetch('/api/settings/system-prompt', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ prompt }),
      });
      if (!res.ok) throw new Error(await res.text());
      setOriginal(prompt);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err: any) {
      setError(err.message ?? 'Error al guardar.');
    }
    setSaving(false);
  }

  const isDirty = prompt !== original;

  if (loading) return (
    <div style={{ padding: '16px', color: '#bbb', fontSize: '14px' }}>Cargando prompt...</div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={10}
        style={{
          width: '100%', background: '#F5F5F5', border: isDirty ? '2px solid #C8FF00' : '2px solid transparent',
          borderRadius: '12px', padding: '14px 16px', fontSize: '13px', color: '#000',
          outline: 'none', resize: 'vertical', fontFamily: 'monospace', lineHeight: 1.6,
          boxSizing: 'border-box', transition: 'border-color 0.2s',
        }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <button
          onClick={handleSave}
          disabled={saving || !isDirty}
          style={{
            background: saving || !isDirty ? '#e0e0e0' : '#C8FF00', color: '#000',
            fontWeight: 800, fontSize: '13px', border: 'none', borderRadius: '10px',
            padding: '9px 20px', cursor: saving || !isDirty ? 'not-allowed' : 'pointer',
            opacity: saving || !isDirty ? 0.6 : 1,
          }}
        >
          {saving ? 'Guardando...' : 'Guardar prompt'}
        </button>
        {isDirty && (
          <button
            onClick={() => setPrompt(original)}
            style={{
              background: 'transparent', color: '#888', fontSize: '12px', fontWeight: 600,
              border: '1px solid #ddd', borderRadius: '10px', padding: '9px 14px', cursor: 'pointer',
            }}
          >
            Descartar cambios
          </button>
        )}
        {saved && <span style={{ fontSize: '13px', color: '#1a7a3a', fontWeight: 700 }}>✅ Guardado</span>}
        {error && <span style={{ fontSize: '13px', color: '#E53935', fontWeight: 700 }}>{error}</span>}
      </div>
      <p style={{ fontSize: '11px', color: '#bbb', margin: 0 }}>
        {prompt.length} caracteres · El bot usa este prompt como base cuando Groq está activo.
      </p>
    </div>
  );
}
