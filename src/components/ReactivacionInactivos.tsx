"use client";

import React, { useEffect, useMemo, useState } from 'react';

type Inactivo = { id: string; phone: string; name: string | null; casino_username: string | null };
type SendResult = { sent: number; failed: number; total: number };

export default function ReactivacionInactivos() {
  const [contacts, setContacts] = useState<Inactivo[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sending,  setSending]  = useState(false);
  const [result,   setResult]   = useState<SendResult | null>(null);
  const [error,    setError]    = useState('');

  async function fetchInactivos() {
    setLoading(true);
    try {
      const res = await fetch('/api/campaigns/reactivacion');
      if (!res.ok) throw new Error(await res.text());
      const data: Inactivo[] = await res.json();
      setContacts(data);
      setSelected(new Set(data.map((c) => c.id))); // todos seleccionados por defecto
    } catch (e: any) {
      setError(e.message ?? 'No se pudieron cargar los inactivos.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { fetchInactivos(); }, []);

  const allSelected = contacts.length > 0 && selected.size === contacts.length;

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(contacts.map((c) => c.id)));
  }

  function displayName(c: Inactivo) {
    return (c.casino_username ?? '').trim() || (c.name ?? '').trim() || c.phone;
  }

  async function enviar() {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    if (!confirm(`¿Enviar la campaña de reactivación a ${ids.length} contacto${ids.length !== 1 ? 's' : ''} inactivo${ids.length !== 1 ? 's' : ''}?`)) return;

    setSending(true);
    setResult(null);
    setError('');
    try {
      const res = await fetch('/api/campaigns/reactivacion', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ contactIds: ids }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setResult({ sent: data.sent ?? 0, failed: data.failed ?? 0, total: data.total ?? 0 });
      fetchInactivos(); // refrescar (algunos pueden cambiar de estado luego)
    } catch (e: any) {
      setError(e.message ?? 'Error al enviar la campaña.');
    } finally {
      setSending(false);
    }
  }

  const selectedCount = useMemo(() => selected.size, [selected]);

  return (
    <div style={{ background: '#fff', borderRadius: '16px', padding: '24px', boxShadow: '0 2px 16px rgba(0,0,0,0.07)', marginBottom: '20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' }}>
        <div>
          <p style={{ fontSize: '16px', fontWeight: 800, color: '#000', margin: 0 }}>
            Reactivación de inactivos
          </p>
          <p style={{ fontSize: '13px', color: '#999', margin: '4px 0 0 0' }}>
            Envía la plantilla <strong style={{ color: '#333' }}>reactivacion_inactivos</strong> (con el nombre del contacto) a los inactivos seleccionados.
          </p>
        </div>
        <button
          onClick={enviar}
          disabled={sending || selectedCount === 0}
          style={{
            background:   sending || selectedCount === 0 ? '#e0e0e0' : '#1a1a1a',
            color:        sending || selectedCount === 0 ? '#999' : '#C8FF00',
            fontWeight:   800, fontSize: '13px', border: 'none',
            borderRadius: '999px', padding: '12px 22px',
            cursor:       sending || selectedCount === 0 ? 'not-allowed' : 'pointer',
            whiteSpace:   'nowrap',
          }}
        >
          {sending ? 'Enviando…' : `Enviar campaña de reactivación (${selectedCount})`}
        </button>
      </div>

      {result && (
        <p style={{ fontSize: '13px', fontWeight: 700, color: '#1a7a3a', margin: '14px 0 0 0' }}>
          ✅ Campaña enviada: {result.sent} enviados{result.failed > 0 ? `, ${result.failed} fallidos` : ''} (de {result.total}).
        </p>
      )}
      {error && (
        <p style={{ fontSize: '13px', fontWeight: 700, color: '#E53935', margin: '14px 0 0 0' }}>✗ {error}</p>
      )}

      <div style={{ marginTop: '18px' }}>
        {loading ? (
          <p style={{ fontSize: '13px', color: '#bbb', margin: 0 }}>Cargando inactivos…</p>
        ) : contacts.length === 0 ? (
          <p style={{ fontSize: '13px', color: '#bbb', margin: 0 }}>No hay contactos con estado “inactivo”.</p>
        ) : (
          <>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px', cursor: 'pointer', fontSize: '13px', fontWeight: 700, color: '#555' }}>
              <input type="checkbox" checked={allSelected} onChange={toggleAll} />
              Seleccionar todos ({contacts.length})
            </label>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '360px', overflowY: 'auto' }}>
              {contacts.map((c) => (
                <label
                  key={c.id}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '10px',
                    padding: '8px 12px', borderRadius: '10px',
                    background: selected.has(c.id) ? '#f7ffe0' : '#fafafa',
                    cursor: 'pointer',
                  }}
                >
                  <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} />
                  <span style={{ fontSize: '13px', fontWeight: 700, color: '#000', flex: 1 }}>{displayName(c)}</span>
                  <span style={{ fontSize: '12px', color: '#999' }}>{c.phone}</span>
                </label>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
