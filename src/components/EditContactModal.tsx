'use client';

import React, { useState } from 'react';
import { InfoCategorias } from '@/components/ui/InfoCategorias';

// Modal de edición de un contacto existente. Permite editar usuario de casino,
// nombre, teléfono y estado. Postea a PATCH /api/contacts; el backend valida y
// aísla por tenant (chequea duplicado de teléfono). Maneja 409 (duplicado) y 400.

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: 'nuevo',          label: 'Nuevo' },
  { value: 'cliente_activo', label: 'Cliente activo' },
  { value: 'inactivo',       label: 'Inactivo' },
  { value: 'en_proceso',     label: 'En proceso' },
  { value: 'bloqueado',      label: 'Bloqueado' },
];

function phoneDigits(raw: string): string {
  return raw.replace(/[\s\-().]/g, '');
}

const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000,
  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px',
};
const card: React.CSSProperties = {
  background: '#fff', borderRadius: '16px', width: '100%', maxWidth: '440px',
  padding: '22px', display: 'flex', flexDirection: 'column', gap: '14px',
  boxShadow: '0 20px 60px rgba(0,0,0,0.35)',
};
const label: React.CSSProperties = { fontSize: '12px', fontWeight: 700, color: '#666', marginBottom: '5px' };
const input: React.CSSProperties = {
  width: '100%', padding: '11px 13px', border: '2px solid #eee', borderRadius: '10px',
  fontSize: '14px', fontWeight: 600, outline: 'none', background: '#F7F7F7', boxSizing: 'border-box',
};

export type EditableContact = {
  id: string;
  casino_username: string;
  name?: string | null;
  phone: string;
  status: string;
};

export default function EditContactModal({ contact, onClose, onSaved }: {
  contact: EditableContact;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [casinoUsername, setCasinoUsername] = useState(contact.casino_username ?? '');
  const [name,           setName]           = useState(contact.name ?? '');
  const [phone,          setPhone]          = useState(contact.phone ?? '');
  const [status,         setStatus]         = useState(contact.status ?? 'nuevo');
  const [busy,           setBusy]           = useState(false);
  const [error,          setError]          = useState<string | null>(null);

  const casinoOk = casinoUsername.trim().length > 0;
  const phoneOk  = phoneDigits(phone).length >= 7;
  const canSave  = casinoOk && phoneOk && !busy;

  async function handleSave() {
    if (!canSave) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch('/api/contacts', {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          id:              contact.id,
          casino_username: casinoUsername.trim(),
          name:            name.trim(),
          phone,
          status,
        }),
      });
      if (res.ok) {
        onSaved();
        onClose();
        return;
      }
      const data = await res.json().catch(() => ({} as any));
      setError(data?.error || 'No se pudo guardar el contacto.');
    } catch {
      setError('Error de red. Reintentá.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div onClick={busy ? undefined : onClose} style={overlay}>
      <div onClick={(e) => e.stopPropagation()} style={card}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0, fontSize: '17px', fontWeight: 800, color: '#000' }}>Editar contacto</h3>
          <button onClick={onClose} disabled={busy} aria-label="Cerrar" style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#999', fontSize: '22px', lineHeight: 1, padding: '2px' }}>×</button>
        </div>

        {/* Usuario de casino */}
        <div>
          <p style={label}>Usuario de casino *</p>
          <input
            value={casinoUsername}
            onChange={(e) => setCasinoUsername(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && canSave) handleSave(); }}
            placeholder="usuario123"
            autoFocus
            style={input}
          />
        </div>

        {/* Nombre */}
        <div>
          <p style={label}>Nombre</p>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && canSave) handleSave(); }}
            placeholder="Nombre del contacto"
            style={input}
          />
        </div>

        {/* Teléfono */}
        <div>
          <p style={label}>Teléfono *</p>
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && canSave) handleSave(); }}
            placeholder="5491112345678"
            inputMode="tel"
            style={input}
          />
        </div>

        {/* Estado. El ⓘ explica que la categoría la calcula el sistema solo y que
            un cambio manual se revierte — justo la duda que aparece acá. */}
        <div>
          <p style={{ ...label, display: 'flex', alignItems: 'center', gap: '6px' }}>
            Estado <InfoCategorias />
          </p>
          <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ ...input, cursor: 'pointer' }}>
            {STATUS_OPTIONS.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </div>

        {error && (
          <div style={{ background: '#FFE5E5', color: '#CC3333', borderRadius: '10px', padding: '10px 12px', fontSize: '13px', fontWeight: 600 }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: '10px', marginTop: '4px' }}>
          <button
            onClick={onClose}
            disabled={busy}
            style={{ flex: 1, background: '#F0F0F0', color: '#555', fontWeight: 800, fontSize: '14px', border: 'none', borderRadius: '10px', padding: '12px', cursor: busy ? 'not-allowed' : 'pointer' }}
          >
            Cancelar
          </button>
          <button
            onClick={handleSave}
            disabled={!canSave}
            style={{ flex: 1, background: canSave ? '#1a1a1a' : '#e0e0e0', color: canSave ? '#C8FF00' : '#999', fontWeight: 800, fontSize: '14px', border: 'none', borderRadius: '10px', padding: '12px', cursor: canSave ? 'pointer' : 'not-allowed' }}
          >
            {busy ? 'Guardando…' : 'Guardar cambios'}
          </button>
        </div>
      </div>
    </div>
  );
}
