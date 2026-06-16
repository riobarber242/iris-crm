'use client';

import React, { useState } from 'react';
import { SectionCard } from '@/components/ui/SectionCard';

const inputStyle: React.CSSProperties = {
  background: '#F5F5F5', border: '2px solid #eee', borderRadius: '10px',
  padding: '10px 12px', fontSize: '14px', color: '#1a1a1a', outline: 'none', width: '100%',
};

// Cambio de contraseña del propio usuario (agent / operator). Llama a
// POST /api/auth/change-password, que verifica la contraseña actual con scrypt.
export default function ChangePasswordCard() {
  const [current, setCurrent] = useState('');
  const [next,    setNext]    = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving,  setSaving]  = useState(false);
  const [error,   setError]   = useState('');
  const [ok,      setOk]      = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(''); setOk(false);

    if (next.length < 6) { setError('La nueva contraseña debe tener al menos 6 caracteres'); return; }
    if (next !== confirm) { setError('La nueva contraseña y su confirmación no coinciden'); return; }

    setSaving(true);
    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: current, newPassword: next, confirmPassword: confirm }),
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok) {
        setOk(true);
        setCurrent(''); setNext(''); setConfirm('');
      } else {
        setError(d.error ?? 'No se pudo cambiar la contraseña');
      }
    } catch {
      setError('Error de red');
    } finally {
      setSaving(false);
    }
  }

  return (
    <SectionCard title="Cambiar contraseña" description="Actualizá tu contraseña de acceso. Necesitás tu contraseña actual.">
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '14px', maxWidth: '380px' }}>
        {error && (
          <div style={{ background: '#FFE5E5', color: '#CC3333', borderRadius: '10px', padding: '10px 14px', fontSize: '13px', fontWeight: 600 }}>
            {error}
          </div>
        )}
        {ok && (
          <div style={{ background: '#E8F5E9', color: '#1a8a1a', borderRadius: '10px', padding: '10px 14px', fontSize: '13px', fontWeight: 600 }}>
            Contraseña actualizada ✅
          </div>
        )}

        <Field label="Contraseña actual">
          <input style={inputStyle} type="password" autoComplete="current-password" value={current} onChange={e => setCurrent(e.target.value)} />
        </Field>
        <Field label="Nueva contraseña">
          <input style={inputStyle} type="password" autoComplete="new-password" value={next} onChange={e => setNext(e.target.value)} />
        </Field>
        <Field label="Confirmar nueva contraseña">
          <input style={inputStyle} type="password" autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} />
        </Field>

        <button
          type="submit"
          disabled={saving}
          style={{ background: '#C8FF00', color: '#000', fontWeight: 700, fontSize: '14px', border: 'none', borderRadius: '10px', padding: '11px 18px', cursor: 'pointer', alignSelf: 'flex-start', opacity: saving ? 0.6 : 1 }}
        >
          {saving ? 'Guardando…' : 'Cambiar contraseña'}
        </button>
      </form>
    </SectionCard>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <label style={{ fontSize: '12px', fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</label>
      {children}
    </div>
  );
}
