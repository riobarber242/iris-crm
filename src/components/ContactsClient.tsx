"use client";

import React, { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';

type ContactRow = {
  id:             string;
  name:           string;
  phone:          string;
  status:         string;
  casino_username: string | null;
  created_at:     string;
};

const STATUS_COLOR: Record<string, { bg: string; fg: string }> = {
  nuevo:       { bg: '#F0F0F0', fg: '#888' },
  en_proceso:  { bg: '#C8FF00', fg: '#000' },
  activo:      { bg: '#C8FF00', fg: '#000' },
  done:        { bg: '#e8f5e9', fg: '#2e7d32' },
};

export default function ContactsClient() {
  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [query,    setQuery]    = useState('');

  async function fetchContacts() {
    try {
      const res = await fetch('/api/contacts');
      if (!res.ok) return;
      setContacts(await res.json());
    } catch {}
    finally { setLoading(false); }
  }

  useEffect(() => {
    fetchContacts();
    const timer = setInterval(fetchContacts, 15_000);
    return () => clearInterval(timer);
  }, []);

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return contacts;
    return contacts.filter(c =>
      c.name?.toLowerCase().includes(q) ||
      c.phone?.includes(q) ||
      (c.casino_username ?? '').toLowerCase().includes(q),
    );
  }, [contacts, query]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

      {/* Search */}
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Buscar por nombre, usuario casino o teléfono..."
        style={{
          width: '100%',
          padding: '12px 16px',
          fontSize: '14px',
          border: '2px solid #e0e0e0',
          borderRadius: '12px',
          outline: 'none',
          background: '#fff',
          boxSizing: 'border-box',
        }}
      />

      {loading && (
        <p style={{ textAlign: 'center', color: '#999', fontSize: '14px' }}>Cargando contactos...</p>
      )}

      {!loading && filtered.length === 0 && (
        <p style={{ textAlign: 'center', color: '#999', fontSize: '14px' }}>
          {query ? 'Sin resultados para esa búsqueda.' : 'No hay contactos agendados.'}
        </p>
      )}

      {/* Table header */}
      {filtered.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div style={{
            display: 'grid',
            gridTemplateColumns: '44px 1fr 1fr 1fr 100px 130px 44px',
            gap: '12px',
            padding: '8px 16px',
            fontSize: '11px',
            fontWeight: 700,
            color: '#aaa',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
          }}>
            <span />
            <span>Nombre</span>
            <span>Usuario casino</span>
            <span>Teléfono</span>
            <span>Estado</span>
            <span>Alta</span>
            <span />
          </div>

          {filtered.map((c) => {
            const initial = c.name.charAt(0).toUpperCase();
            const sc      = STATUS_COLOR[c.status] ?? STATUS_COLOR.nuevo;
            return (
              <div key={c.id} style={{
                display: 'grid',
                gridTemplateColumns: '44px 1fr 1fr 1fr 100px 130px 44px',
                gap: '12px',
                alignItems: 'center',
                background: '#fff',
                borderRadius: '14px',
                padding: '12px 16px',
                boxShadow: '0 1px 6px rgba(0,0,0,0.06)',
              }}>
                {/* Avatar */}
                <div style={{
                  width: '36px', height: '36px', borderRadius: '50%',
                  background: '#C8FF00', display: 'flex', alignItems: 'center',
                  justifyContent: 'center', fontWeight: 800, fontSize: '15px', color: '#000',
                }}>
                  {initial}
                </div>

                {/* Nombre */}
                <p style={{ margin: 0, fontSize: '14px', fontWeight: 700, color: '#111', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {c.name}
                </p>

                {/* Casino username */}
                <p style={{ margin: 0, fontSize: '13px', color: c.casino_username ? '#444' : '#ccc', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {c.casino_username || '—'}
                </p>

                {/* Teléfono */}
                <p style={{ margin: 0, fontSize: '13px', color: '#666' }}>{c.phone}</p>

                {/* Estado */}
                <span style={{
                  ...sc,
                  borderRadius: '999px',
                  padding: '4px 10px',
                  fontSize: '11px',
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                  display: 'inline-block',
                  textAlign: 'center',
                }}>
                  {c.status}
                </span>

                {/* Fecha */}
                <p style={{ margin: 0, fontSize: '12px', color: '#aaa' }}>
                  {new Date(c.created_at).toLocaleDateString('es-AR')}
                </p>

                {/* Botón conversación */}
                <Link href={`/conversations/${c.id}`} style={{ textDecoration: 'none' }}>
                  <div style={{
                    width: '32px', height: '32px', borderRadius: '8px',
                    background: '#1a1a1a', display: 'flex', alignItems: 'center',
                    justifyContent: 'center', cursor: 'pointer', fontSize: '16px',
                  }} title="Ir a conversación">
                    💬
                  </div>
                </Link>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
