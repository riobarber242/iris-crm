'use client';

import React, { useState } from 'react';
import { inferProvinciaFromPhone } from '@/lib/phone-province';

// Modal de alta individual de contacto. Campos: usuario de casino y teléfono
// (obligatorios), estado (default "nuevo") y provincia (autocompletada desde el
// teléfono, pero editable a mano). Postea a POST /api/contacts; el backend
// vuelve a validar y aísla por tenant. Maneja el 409 de duplicado.

// Estados válidos (alineado con el backend y el selector de la lista).
const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: 'nuevo',          label: 'Nuevo' },
  { value: 'cliente_activo', label: 'Cliente activo' },
  { value: 'inactivo',       label: 'Inactivo' },
  { value: 'en_proceso',     label: 'En proceso' },
  { value: 'bloqueado',      label: 'Bloqueado' },
];

// Mismo criterio de validez que el backend (≥7 dígitos tras quitar separadores).
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

export default function NewContactModal({ onClose, onCreated }: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [casinoUsername, setCasinoUsername] = useState('');
  const [phone,          setPhone]          = useState('');
  const [status,         setStatus]         = useState('nuevo');
  const [provincia,      setProvincia]      = useState('');
  const [provinciaTouched, setProvinciaTouched] = useState(false);
  const [busy,           setBusy]           = useState(false);
  const [error,          setError]          = useState<string | null>(null);

  // Al tipear el teléfono, autocompletar provincia SOLO si el usuario no la editó
  // a mano (si la tocó, respetamos lo que puso).
  function handlePhoneChange(value: string) {
    setPhone(value);
    if (!provinciaTouched) {
      setProvincia(inferProvinciaFromPhone(value) ?? '');
    }
  }

  const casinoOk = casinoUsername.trim().length > 0;
  const phoneOk  = phoneDigits(phone).length >= 7;
  const canSave  = casinoOk && phoneOk && !busy;

  async function handleSave() {
    if (!canSave) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch('/api/contacts', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          casino_username: casinoUsername.trim(),
          phone,
          status,
          provincia: provincia.trim() || undefined,
        }),
      });
      if (res.ok) {
        onCreated();
        onClose();
        return;
      }
      // 409 (duplicado) y 400 (validación) traen { error } legible.
      const data = await res.json().catch(() => ({} as any));
      setError(data?.error || 'No se pudo crear el contacto.');
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
          <h3 style={{ margin: 0, fontSize: '17px', fontWeight: 800, color: '#000' }}>Nuevo contacto</h3>
          <button onClick={onClose} disabled={busy} aria-label="Cerrar" style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#999', fontSize: '22px', lineHeight: 1, padding: '2px' }}>×</button>
        </div>

        {/* Usuario de casino (obligatorio) */}
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

        {/* Teléfono (obligatorio) */}
        <div>
          <p style={label}>Teléfono *</p>
          <input
            value={phone}
            onChange={(e) => handlePhoneChange(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && canSave) handleSave(); }}
            placeholder="5491112345678"
            inputMode="tel"
            style={input}
          />
        </div>

        {/* Estado */}
        <div>
          <p style={label}>Estado</p>
          <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ ...input, cursor: 'pointer' }}>
            {STATUS_OPTIONS.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </div>

        {/* Provincia (autocompletada del teléfono, editable) */}
        <div>
          <p style={label}>Provincia</p>
          <input
            value={provincia}
            onChange={(e) => { setProvincia(e.target.value); setProvinciaTouched(true); }}
            placeholder="Se completa según el teléfono"
            style={input}
          />
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
            {busy ? 'Guardando…' : 'Crear contacto'}
          </button>
        </div>
      </div>
    </div>
  );
}
