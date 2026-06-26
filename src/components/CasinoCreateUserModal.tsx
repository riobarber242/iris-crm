'use client';

import React, { useState } from 'react';

// Sugiere un username de casino a partir del nombre del contacto:
// <primeras 5 letras del nombre, sin espacios ni acentos, lowercase> + "1js".
// Si no hay nombre usable, cae a "jugador".
function suggestUsername(name?: string | null): string {
  const slug = (name ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')  // saca acentos
    .toLowerCase().replace(/[^a-z0-9]/g, '')           // solo alfanumérico
    .slice(0, 5);
  return `${slug || 'jugador'}1js`;
}

// Modal para crear un usuario en el casino. Compartido por ContactHeader y
// ChatWindow. En éxito llama onCreated(username): el padre actualiza su estado y
// cierra. Las credenciales NO se muestran acá — el endpoint las manda al cliente
// por WhatsApp y las deja guardadas en el chat.
export default function CasinoCreateUserModal({
  contactId,
  contactName,
  onClose,
  onCreated,
}: {
  contactId: string;
  contactName: string | null;
  onClose: () => void;
  onCreated: (username: string) => void;
}) {
  const [createUser,  setCreateUser]  = useState(() => suggestUsername(contactName));
  const [creating,    setCreating]    = useState(false);
  const [createError, setCreateError] = useState('');

  async function createCasinoPlayer() {
    const suggested = createUser.trim().toLowerCase();
    if (!suggested) { setCreateError('Ingresá un nombre de usuario'); return; }
    setCreating(true);
    setCreateError('');
    try {
      const res = await fetch('/api/casino/create-player', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ contactId, suggestedUsername: suggested }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        onCreated(data.username);
      } else {
        setCreateError(data.error || 'No se pudo crear el usuario en el casino');
      }
    } catch {
      setCreateError('Error de red');
    } finally {
      setCreating(false);
    }
  }

  return (
    <div
      onClick={() => { if (!creating) onClose(); }}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '20px',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff', borderRadius: '18px', padding: '24px', width: '100%', maxWidth: '420px',
          boxShadow: '0 12px 40px rgba(0,0,0,0.25)', display: 'flex', flexDirection: 'column', gap: '14px',
        }}
      >
        <h3 style={{ margin: 0, fontSize: '17px', fontWeight: 900, color: '#111' }}>
          🎰 Crear usuario en el casino
        </h3>

        <p style={{ margin: 0, fontSize: '13px', color: '#666', lineHeight: 1.5 }}>
          Se creará un jugador con una contraseña automática. Las credenciales se le
          envían al cliente por WhatsApp y quedan en el chat.
        </p>

        <label style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '12px', fontWeight: 700, color: '#888' }}>
          Usuario
          <input
            value={createUser}
            onChange={(e) => setCreateUser(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !creating) createCasinoPlayer(); }}
            autoFocus
            style={{
              background: '#F5F5F5', border: 'none', borderRadius: '10px',
              padding: '10px 14px', fontSize: '15px', fontWeight: 700, color: '#000', outline: 'none',
            }}
          />
        </label>

        {createError && (
          <p style={{ margin: 0, fontSize: '13px', color: '#c0392b', fontWeight: 600 }}>{createError}</p>
        )}

        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <button
            onClick={onClose}
            disabled={creating}
            style={{ background: '#F0F0F0', color: '#666', fontWeight: 600, border: 'none', borderRadius: '10px', padding: '10px 16px', cursor: creating ? 'not-allowed' : 'pointer', fontSize: '13px' }}
          >
            Cancelar
          </button>
          <button
            onClick={createCasinoPlayer}
            disabled={creating}
            style={{ background: '#1a1a1a', color: '#C8FF00', fontWeight: 800, border: 'none', borderRadius: '10px', padding: '10px 20px', cursor: creating ? 'not-allowed' : 'pointer', fontSize: '13px', opacity: creating ? 0.6 : 1 }}
          >
            {creating ? 'Creando…' : 'Crear'}
          </button>
        </div>
      </div>
    </div>
  );
}
