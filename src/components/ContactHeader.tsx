"use client";

import React, { useState } from 'react';

export default function ContactHeader({
  contactId,
  initialName,
  phone,
  initialCasinoUsername,
}: {
  contactId:            string;
  initialName:          string | null;
  phone:                string;
  initialCasinoUsername?: string | null;
}) {
  const [name,          setName]          = useState(initialName          ?? '');
  const [casinoUser,    setCasinoUser]    = useState(initialCasinoUsername ?? '');
  const [editing,       setEditing]       = useState(false);
  const [loading,       setLoading]       = useState(false);

  async function save() {
    setLoading(true);
    try {
      const res = await fetch('/api/conversations', {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ contactId, name, casino_username: casinoUser }),
      });
      if (res.ok) setEditing(false);
    } catch {}
    setLoading(false);
  }

  return (
    <div style={{
      background: '#FFFFFF',
      borderRadius: '16px',
      padding: '16px 20px',
      boxShadow: '0 2px 16px rgba(0,0,0,0.07)',
      display: 'flex',
      alignItems: 'center',
      gap: '16px',
      width: '100%',
    }}>
      {/* Avatar */}
      <div style={{
        width: '44px', height: '44px', borderRadius: '50%',
        background: '#C8FF00', display: 'flex', alignItems: 'center',
        justifyContent: 'center', fontWeight: 800, fontSize: '18px',
        color: '#000', flexShrink: 0,
      }}>
        {(name || phone).charAt(0).toUpperCase()}
      </div>

      <div style={{ flex: 1 }}>
        {editing ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Nombre"
                style={{ background: '#F5F5F5', border: 'none', borderRadius: '10px', padding: '8px 12px', fontSize: '14px', color: '#000', outline: 'none', minWidth: '150px' }}
              />
              <input
                value={casinoUser}
                onChange={(e) => setCasinoUser(e.target.value)}
                placeholder="Usuario casino"
                style={{ background: '#F5F5F5', border: 'none', borderRadius: '10px', padding: '8px 12px', fontSize: '14px', color: '#000', outline: 'none', minWidth: '150px' }}
              />
              <button disabled={loading} onClick={save}
                style={{ background: '#C8FF00', color: '#000', fontWeight: 700, border: 'none', borderRadius: '10px', padding: '8px 16px', cursor: 'pointer', fontSize: '13px' }}>
                Guardar
              </button>
              <button onClick={() => setEditing(false)}
                style={{ background: '#F0F0F0', color: '#666', fontWeight: 600, border: 'none', borderRadius: '10px', padding: '8px 16px', cursor: 'pointer', fontSize: '13px' }}>
                Cancelar
              </button>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
            <div>
              <h2 style={{ fontSize: '17px', fontWeight: 800, color: '#000', margin: 0 }}>{name || phone}</h2>
              {casinoUser && (
                <p style={{ fontSize: '12px', color: '#666', margin: '2px 0 0 0', fontWeight: 600 }}>
                  🎰 {casinoUser}
                </p>
              )}
              <p style={{ fontSize: '12px', color: '#999', margin: '2px 0 0 0' }}>{phone}</p>
            </div>
            <button onClick={() => setEditing(true)}
              style={{ background: '#F0F0F0', color: '#666', fontWeight: 600, border: 'none', borderRadius: '8px', padding: '4px 12px', cursor: 'pointer', fontSize: '12px' }}>
              Editar
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
