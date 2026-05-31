"use client";

import React, { useState } from 'react';

export default function ContactHeader({ contactId, initialName, phone }: { contactId: string; initialName: string | null; phone: string }) {
  const [name, setName] = useState(initialName ?? '');
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(false);

  async function saveName() {
    setLoading(true);
    try {
      const res = await fetch('/api/conversations', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactId, name }),
      });
      if (res.ok) {
        setEditing(false);
      } else {
        console.error('Error saving name');
      }
    } catch (e) {
      console.error(e);
    }
    setLoading(false);
  }

  return (
    <div className="flex items-center gap-4">
      <div>
        {editing ? (
          <div className="flex items-center gap-2">
            <input value={name} onChange={(e) => setName(e.target.value)} className="rounded p-2 bg-[#0b0b11] text-white" />
            <button disabled={loading} onClick={saveName} className="rounded bg-iris-pink px-3 py-1 text-white">
              Guardar
            </button>
            <button onClick={() => setEditing(false)} className="rounded bg-white/5 px-3 py-1 text-white">
              Cancelar
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <h2 className="text-2xl font-semibold text-white">{name || phone}</h2>
            <button onClick={() => setEditing(true)} className="rounded bg-white/5 px-3 py-1 text-white">
              Editar
            </button>
          </div>
        )}
        <p className="text-sm text-iris-text-muted">{phone}</p>
      </div>
    </div>
  );
}
