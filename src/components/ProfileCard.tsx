'use client';

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from './AuthProvider';

// ── Perfil de usuario en el sidebar ──────────────────────────────────────────
// Card al pie del sidebar (todos los roles) con avatar + nombre + rol.
// Al click abre un modal para editar foto (2MB, jpg/png/webp), nombre y
// teléfono. Solo edita el PROPIO perfil (la API usa la sesión, no acepta ids).
// El modal se renderiza con portal en <body>: el sidebar mobile está
// transformado (drawer) y un position:fixed adentro quedaría atrapado.

const ROLE_LABEL: Record<string, string> = { admin: 'Admin', agent: 'Agente', operator: 'Operador' };
const MAX_BYTES = 2 * 1024 * 1024;
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0][0] ?? '';
  const second = parts.length > 1 ? (parts[parts.length - 1][0] ?? '') : (parts[0][1] ?? '');
  return (first + second).toUpperCase();
}

export function Avatar({ url, name, size }: { url?: string | null; name: string; size: number }) {
  if (url) {
    return (
      <img
        src={url}
        alt={name}
        style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', flexShrink: 0, display: 'block' }}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      style={{
        width: size, height: size, borderRadius: '50%', flexShrink: 0,
        background: '#1a1a1a', color: '#C8FF00',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        fontSize: Math.round(size * 0.38), fontWeight: 800, letterSpacing: '0.02em',
        userSelect: 'none',
      }}
    >
      {initials(name)}
    </span>
  );
}

export default function ProfileCard() {
  const { agent, refresh } = useAuth();
  const [open, setOpen] = useState(false);

  if (!agent) return null;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Editar perfil"
        style={{
          marginTop: 'auto',
          display: 'flex', alignItems: 'center', gap: '10px',
          width: '100%', textAlign: 'left',
          background: '#F7F7F7', border: '1px solid #eee', borderRadius: '12px',
          padding: '10px 12px', cursor: 'pointer',
        }}
      >
        <Avatar url={agent.avatar_url} name={agent.name} size={38} />
        <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column', lineHeight: 1.2 }}>
          <span style={{ fontSize: '13px', fontWeight: 800, color: '#111', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {agent.name}
          </span>
          <span style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#999' }}>
            {ROLE_LABEL[agent.role] ?? agent.role}
          </span>
        </span>
      </button>

      {open && <ProfileModal onClose={() => setOpen(false)} onSaved={() => { refresh(); }} />}
    </>
  );
}

function ProfileModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => Promise<void> | void }) {
  const { agent } = useAuth();
  const [name, setName]   = useState(agent?.name ?? '');
  const [phone, setPhone] = useState(agent?.phone ?? '');
  const [file, setFile]   = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => { setMounted(true); }, []);
  // Liberar el object URL del preview al desmontar o reemplazar.
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  function pickFile(f: File | null) {
    setError('');
    if (!f) return;
    if (!ALLOWED_TYPES.includes(f.type)) { setError('Formato no permitido. Usá JPG, PNG o WebP.'); return; }
    if (f.size > MAX_BYTES) { setError('La imagen supera los 2MB.'); return; }
    if (preview) URL.revokeObjectURL(preview);
    setFile(f);
    setPreview(URL.createObjectURL(f));
  }

  async function save() {
    setError('');
    const trimmed = name.trim();
    if (!trimmed) { setError('El nombre no puede quedar vacío.'); return; }
    setSaving(true);
    try {
      // 1. Foto (si eligió una nueva)
      if (file) {
        const fd = new FormData();
        fd.append('file', file);
        const up = await fetch('/api/profile/avatar', { method: 'POST', body: fd });
        const upBody = await up.json().catch(() => ({}));
        if (!up.ok) { setError(upBody.error ?? 'No se pudo subir la foto.'); return; }
      }
      // 2. Nombre + teléfono (solo si cambiaron)
      const changes: Record<string, string> = {};
      if (trimmed !== agent?.name) changes.name = trimmed;
      if ((phone ?? '').trim() !== (agent?.phone ?? '')) changes.phone = phone.trim();
      if (Object.keys(changes).length > 0) {
        const res = await fetch('/api/profile', {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(changes),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) { setError(body.error ?? 'No se pudo guardar.'); return; }
      }
      await onSaved();
      onClose();
    } catch {
      setError('Error de red.');
    } finally {
      setSaving(false);
    }
  }

  if (!mounted) return null;

  return createPortal(
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 3000, background: 'rgba(0,0,0,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff', borderRadius: '20px', width: '100%', maxWidth: '380px',
          padding: '22px', boxShadow: '0 12px 48px rgba(0,0,0,0.3)',
          display: 'flex', flexDirection: 'column', gap: '16px',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0, fontSize: '17px', fontWeight: 900, color: '#000' }}>Mi perfil</h2>
          <button onClick={onClose} aria-label="Cerrar" style={{ background: '#F0F0F0', color: '#666', border: 'none', borderRadius: '8px', width: '32px', height: '32px', fontSize: '15px', cursor: 'pointer' }}>✕</button>
        </div>

        {error && (
          <div style={{ background: '#FFE5E5', color: '#CC3333', borderRadius: '10px', padding: '9px 12px', fontSize: '13px', fontWeight: 600 }}>
            {error}
          </div>
        )}

        {/* Foto */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          {preview
            ? <img src={preview} alt="Vista previa" style={{ width: 64, height: 64, borderRadius: '50%', objectFit: 'cover', display: 'block' }} />
            : <Avatar url={agent?.avatar_url} name={agent?.name ?? ''} size={64} />}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <button
              onClick={() => fileRef.current?.click()}
              style={{ background: '#1a1a1a', color: '#C8FF00', border: 'none', borderRadius: '10px', padding: '8px 14px', fontSize: '13px', fontWeight: 700, cursor: 'pointer' }}
            >
              {agent?.avatar_url || preview ? 'Cambiar foto' : 'Subir foto'}
            </button>
            <span style={{ fontSize: '11px', color: '#aaa' }}>JPG, PNG o WebP · máx. 2MB</span>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            style={{ display: 'none' }}
            onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
          />
        </div>

        {/* Nombre */}
        <label style={{ display: 'flex', flexDirection: 'column', gap: '5px', fontSize: '11px', fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Nombre
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} style={inputStyle} />
        </label>

        {/* Teléfono */}
        <label style={{ display: 'flex', flexDirection: 'column', gap: '5px', fontSize: '11px', fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Teléfono
          <input value={phone ?? ''} onChange={(e) => setPhone(e.target.value)} placeholder="+54 9 11 ..." style={inputStyle} />
        </label>

        <button
          onClick={save}
          disabled={saving}
          style={{
            background: '#C8FF00', color: '#000', border: 'none', borderRadius: '12px',
            padding: '12px', fontSize: '14px', fontWeight: 800,
            cursor: saving ? 'not-allowed' : 'pointer',
          }}
        >
          {saving ? 'Guardando…' : 'Guardar'}
        </button>
      </div>
    </div>,
    document.body,
  );
}

const inputStyle: React.CSSProperties = {
  background: '#F5F5F5', border: '2px solid #eee', borderRadius: '10px',
  padding: '10px 12px', fontSize: '14px', color: '#1a1a1a', outline: 'none',
  fontWeight: 500, textTransform: 'none', letterSpacing: 'normal',
};
