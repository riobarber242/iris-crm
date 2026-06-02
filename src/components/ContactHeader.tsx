"use client";

import React, { useState } from 'react';

const STATUS_OPTIONS = [
  { value: 'nuevo',          label: 'Nuevo' },
  { value: 'cliente_activo', label: 'Cliente activo' },
  { value: 'inactivo',       label: 'Inactivo' },
  { value: 'en_proceso',     label: 'En proceso' },
];

const STATUS_COLOR: Record<string, { bg: string; fg: string }> = {
  nuevo:          { bg: '#F0F0F0', fg: '#888' },
  cliente_activo: { bg: '#C8FF00', fg: '#000' },
  inactivo:       { bg: '#888',    fg: '#fff' },
  en_proceso:     { bg: '#C8FF00', fg: '#000' },
};

export default function ContactHeader({
  contactId,
  phone,
  initialCasinoUsername,
  initialBlocked,
  initialStatus,
}: {
  contactId:             string;
  phone:                 string;
  initialCasinoUsername?: string | null;
  initialBlocked?:       boolean;
  initialStatus?:        string | null;
}) {
  const [casinoUser,   setCasinoUser]   = useState(initialCasinoUsername ?? '');
  const [editing,      setEditing]      = useState(false);
  const [loading,      setLoading]      = useState(false);
  const [blocked,      setBlocked]      = useState(initialBlocked ?? false);
  const [status,       setStatus]       = useState(initialStatus ?? 'nuevo');
  const [statusLoading,setStatusLoading]= useState(false);

  async function handleStatusChange(newStatus: string) {
    setStatusLoading(true);
    try {
      await fetch('/api/conversations', {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ contactId, status: newStatus }),
      });
      setStatus(newStatus);
    } catch {}
    setStatusLoading(false);
  }

  async function handleBlock() {
    if (!confirm('¿Seguro que querés bloquear este contacto? El bot dejará de responderle.')) return;
    await fetch('/api/conversations', {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ contactId, blocked: true }),
    });
    setBlocked(true);
    window.location.reload();
  }

  async function handleUnblock() {
    await fetch('/api/conversations', {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ contactId, blocked: false }),
    });
    setBlocked(false);
    window.location.reload();
  }

  async function save() {
    setLoading(true);
    try {
      const res = await fetch('/api/conversations', {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ contactId, casino_username: casinoUser }),
      });
      if (res.ok) setEditing(false);
    } catch {}
    setLoading(false);
  }

  const display = casinoUser || phone;
  const initial = display.charAt(0).toUpperCase();

  return (
    <div style={{
      background: '#FFFFFF', borderRadius: '16px', padding: '16px 20px',
      boxShadow: '0 2px 16px rgba(0,0,0,0.07)', display: 'flex',
      alignItems: 'center', gap: '16px', width: '100%',
    }}>
      {/* Avatar */}
      <div style={{
        width: '44px', height: '44px', borderRadius: '50%', background: '#C8FF00',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontWeight: 800, fontSize: '18px', color: '#000', flexShrink: 0,
      }}>
        {initial}
      </div>

      <div style={{ flex: 1 }}>
        {editing ? (
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              value={casinoUser}
              onChange={(e) => setCasinoUser(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }}
              placeholder="Usuario casino"
              autoFocus
              style={{
                background: '#F5F5F5', border: 'none', borderRadius: '10px',
                padding: '8px 12px', fontSize: '14px', color: '#000', outline: 'none', minWidth: '180px',
              }}
            />
            <button disabled={loading} onClick={save} style={{
              background: '#C8FF00', color: '#000', fontWeight: 700, border: 'none',
              borderRadius: '10px', padding: '8px 16px', cursor: 'pointer', fontSize: '13px',
            }}>
              Guardar
            </button>
            <button onClick={() => setEditing(false)} style={{
              background: '#F0F0F0', color: '#666', fontWeight: 600, border: 'none',
              borderRadius: '10px', padding: '8px 16px', cursor: 'pointer', fontSize: '13px',
            }}>
              Cancelar
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
            <div>
              {casinoUser && (
                <p style={{ fontSize: '17px', fontWeight: 800, color: '#000', margin: 0 }}>
                  🎰 {casinoUser}
                </p>
              )}
              <p style={{ fontSize: '13px', color: '#999', margin: casinoUser ? '2px 0 0 0' : 0 }}>{phone}</p>
            </div>

            {/* Status selector */}
            <select
              value={status}
              onChange={(e) => handleStatusChange(e.target.value)}
              disabled={statusLoading}
              style={{
                background:   (STATUS_COLOR[status] ?? STATUS_COLOR.nuevo).bg,
                color:        (STATUS_COLOR[status] ?? STATUS_COLOR.nuevo).fg,
                fontWeight:   700,
                fontSize:     '12px',
                border:       'none',
                borderRadius: '8px',
                padding:      '4px 10px',
                cursor:       statusLoading ? 'not-allowed' : 'pointer',
                opacity:      statusLoading ? 0.6 : 1,
                outline:      'none',
              }}
            >
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>

            <button onClick={() => setEditing(true)} style={{
              background: '#F0F0F0', color: '#666', fontWeight: 700, border: 'none',
              borderRadius: '8px', padding: '4px 12px', cursor: 'pointer', fontSize: '12px',
            }}>
              {casinoUser ? 'Editar usuario' : '+ Asignar usuario'}
            </button>
            {blocked ? (
              <button onClick={handleUnblock} style={{
                background: '#22C55E', color: '#fff', fontWeight: 700, border: 'none',
                borderRadius: '8px', padding: '4px 12px', cursor: 'pointer', fontSize: '12px',
              }}>
                ✅ Desbloqueado
              </button>
            ) : (
              <button onClick={handleBlock} style={{
                background: '#FF4444', color: '#fff', fontWeight: 700, border: 'none',
                borderRadius: '8px', padding: '4px 12px', cursor: 'pointer', fontSize: '12px',
              }}>
                🚫 Bloquear
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
