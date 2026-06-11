"use client";

import React, { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { getSupabaseBrowser } from '@/lib/supabase-browser';
import { formatRelativeTime } from '@/lib/formatRelativeTime';
import { classifyPending } from '@/lib/pending';

// El sonido de pendiente nuevo lo dispara AdminShell (centralizado, suena en
// toda la app y diferencia naranja/rojo). Acá ya no se emite beep para no
// duplicarlo.

export default function ConversationsClient() {
  const [conversations,  setConversations]  = useState<any[]>([]);
  const [activeFilter,   setActiveFilter]   = useState<'todos' | 'nuevo' | 'cliente_activo' | 'inactivo' | 'bloqueado'>('todos');
  const [readFilter,     setReadFilter]     = useState<'todos' | 'no_leidos'>('todos');
  const [query,          setQuery]          = useState('');
  const [offline,        setOffline]        = useState(false);
  const [filtersOpen,    setFiltersOpen]    = useState(false);
  const fetchRef       = useRef<() => void>(() => {});
  const sbRef          = useRef<any>(null);
  const channelRef     = useRef<any>(null);
  const filtersRef     = useRef<HTMLDivElement>(null);

  // Número de filtros activos (estado distinto de "todos" + lectura distinta de "todos").
  const activeFilterCount = (activeFilter !== 'todos' ? 1 : 0) + (readFilter !== 'todos' ? 1 : 0);

  // Click fuera del panel de filtros → cerrar.
  useEffect(() => {
    if (!filtersOpen) return;
    function onClickOutside(e: MouseEvent) {
      if (filtersRef.current && !filtersRef.current.contains(e.target as Node)) {
        setFiltersOpen(false);
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [filtersOpen]);

  async function fetchConversations() {
    try {
      const res = await fetch('/api/conversations');
      if (!res.ok) return;
      const data: any[] = await res.json();
      setConversations(data);
    } catch {}
  }

  // Realtime (mensajes + contactos) con polling de respaldo cada 5 s.
  useEffect(() => {
    fetchRef.current = fetchConversations;
    fetchConversations();
    // El modo offline afecta la clasificación (sin offline no hay rojo).
    fetch('/api/settings/offline-mode')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) setOffline(!!d.offline); })
      .catch(() => {});
    const timer = setInterval(() => fetchRef.current(), 5_000);

    const sb = getSupabaseBrowser();
    if (sb) {
      sbRef.current = sb;
      const trigger = () => fetchRef.current();
      const ch = sb.channel('realtime-conversations')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, trigger)
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages' }, trigger)
        .on('postgres_changes', { event: '*',      schema: 'public', table: 'contacts' }, trigger)
        .subscribe();
      channelRef.current = ch;
    }

    return () => {
      clearInterval(timer);
      try { if (channelRef.current) sbRef.current?.removeChannel(channelRef.current); } catch (err) { console.warn('[conversations realtime] removeChannel falló:', err); }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist last_read_at to DB, clear badge optimistically, refresh sidebar badge
  function markRead(contactId: string) {
    // Optimistic update: clear badge in list immediately
    setConversations(prev =>
      prev.map(c =>
        c.id === contactId
          ? { ...c, last_read_at: new Date().toISOString() }
          : c,
      ),
    );
    // Persist to DB
    fetch('/api/conversations', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contactId, markRead: true }),
    }).catch(() => {});
    // Notify AdminShell to refresh the sidebar badge immediately
    window.dispatchEvent(new Event('refresh-unread'));
  }

  const FILTERS: { key: typeof activeFilter; label: string }[] = [
    { key: 'todos',          label: 'Todos' },
    { key: 'nuevo',          label: 'Nuevo' },
    { key: 'cliente_activo', label: 'Cliente activo' },
    { key: 'inactivo',       label: 'Inactivo' },
    { key: 'bloqueado',      label: 'Bloqueado' },
  ];

  // "No leído" = pendiente según classifyPending (naranja/rojo), misma regla
  // que el badge de la lista. Solo frontend, sobre el array en memoria.
  function isUnread(c: any): boolean {
    const lastMessage = (c.messages ?? [])[0];
    return !!classifyPending({
      lastRole:          lastMessage?.role,
      lastMsgAt:         lastMessage?.created_at,
      lastReadAt:        c.last_read_at,
      conversationState: c.conversation_state,
      offline,
    });
  }

  const filtered = conversations.filter((c) => {
    if (activeFilter === 'bloqueado')      { if (c.blocked !== true) return false; }
    else if (activeFilter !== 'todos')     { if (c.status?.toLowerCase() !== activeFilter) return false; }

    if (readFilter === 'no_leidos' && !isUnread(c)) return false;

    if (query.trim()) {
      const q = query.toLowerCase();
      const matchUser  = c.casino_username?.toLowerCase().includes(q);
      const matchName  = c.name?.toLowerCase().includes(q);
      const matchPhone = c.phone?.includes(q);
      if (!matchUser && !matchName && !matchPhone) return false;
    }

    return true;
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>

      {/* Barra: búsqueda + botón Filtros colapsable */}
      <div ref={filtersRef} style={{ position: 'relative', display: 'flex', gap: '8px', alignItems: 'stretch' }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar por usuario casino, nombre o teléfono..."
          style={{
            flex: 1,
            minWidth: 0,
            padding: '12px 16px',
            fontSize: '14px',
            border: '2px solid #e0e0e0',
            borderRadius: '12px',
            outline: 'none',
            background: '#fff',
            boxSizing: 'border-box',
          }}
        />

        <button
          onClick={() => setFiltersOpen((o) => !o)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            flexShrink: 0,
            padding: '0 16px',
            fontSize: '14px',
            fontWeight: 700,
            cursor: 'pointer',
            borderRadius: '12px',
            border: activeFilterCount > 0 ? '2px solid #F97316' : '2px solid #e0e0e0',
            background: activeFilterCount > 0 ? '#F97316' : '#fff',
            color: activeFilterCount > 0 ? '#fff' : '#555',
            transition: 'background 0.15s, color 0.15s, border-color 0.15s',
          }}
        >
          {/* Ícono de embudo */}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
          </svg>
          Filtros
          {activeFilterCount > 0 && (
            <span style={{
              background: '#fff',
              color: '#F97316',
              borderRadius: '999px',
              fontSize: '11px',
              fontWeight: 800,
              minWidth: '18px',
              height: '18px',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '0 5px',
            }}>
              {activeFilterCount}
            </span>
          )}
        </button>

        {/* Panel desplegable: full width en mobile, 320px alineado a la derecha en desktop */}
        {filtersOpen && (
          <div
            style={{
              position: 'absolute',
              top: 'calc(100% + 8px)',
              right: 0,
              left: 0,
              maxWidth: '320px',
              marginLeft: 'auto',
              background: '#fff',
              border: '2px solid #e0e0e0',
              borderRadius: '14px',
              boxShadow: '0 8px 28px rgba(0,0,0,0.12)',
              padding: '14px',
              zIndex: 20,
              display: 'flex',
              flexDirection: 'column',
              gap: '14px',
            }}
          >
            {/* Estado */}
            <div>
              <p style={{ fontSize: '11px', fontWeight: 700, color: '#999', margin: '0 0 8px 0', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Estado</p>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                {FILTERS.map(({ key, label }) => (
                  <button
                    key={key}
                    onClick={() => { setActiveFilter(key); setFiltersOpen(false); }}
                    style={{
                      background:   activeFilter === key ? '#C8FF00' : '#F0F0F0',
                      color:        activeFilter === key ? '#000'    : '#888',
                      border:       'none',
                      borderRadius: '999px',
                      padding:      '6px 16px',
                      fontSize:     '13px',
                      fontWeight:   600,
                      cursor:       'pointer',
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* Lectura */}
            <div>
              <p style={{ fontSize: '11px', fontWeight: 700, color: '#999', margin: '0 0 8px 0', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Lectura</p>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                {([['todos', 'Todos'], ['no_leidos', 'No leídos']] as const).map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => { setReadFilter(key); setFiltersOpen(false); }}
                    style={{
                      background:   readFilter === key ? '#F97316' : '#F0F0F0',
                      color:        readFilter === key ? '#fff'    : '#888',
                      border:       'none',
                      borderRadius: '999px',
                      padding:      '6px 16px',
                      fontSize:     '13px',
                      fontWeight:   600,
                      cursor:       'pointer',
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {filtered.length === 0 && (
        <div style={{ textAlign: 'center', padding: '40px 0', color: '#bbb', fontSize: '14px' }}>
          {query.trim()
            ? `Sin resultados para "${query}".`
            : readFilter === 'no_leidos'
              ? 'No hay conversaciones sin leer.'
              : activeFilter !== 'todos'
                ? `No hay conversaciones con estado "${activeFilter}".`
                : 'No hay conversaciones.'}
        </div>
      )}

      {filtered.map((contact) => {
        const messages: any[] = contact.messages ?? [];
        const lastMessage     = messages[0];

        // Clasificación de pendiente (única fuente de verdad, compartida con la API).
        // markRead() setea last_read_at = NOW() optimistamente → limpia el badge.
        const badgeType = classifyPending({
          lastRole:          lastMessage?.role,
          lastMsgAt:         lastMessage?.created_at,
          lastReadAt:        contact.last_read_at,
          conversationState: contact.conversation_state,
          offline,
        });

        // Cantidad de mensajes del cliente sin leer (para el número del badge).
        const lastReadAt = contact.last_read_at ? new Date(contact.last_read_at) : null;
        let pendingCount = 0;
        for (const msg of messages) {
          if (lastReadAt && new Date(msg.created_at) <= lastReadAt) break; // resto ya leído
          if (msg.role === 'user') pendingCount++;
        }

        const borderColor = badgeType === 'red' ? '#E53935'
                          : badgeType === 'orange' ? '#FF8C00'
                          : null;

        return (
          <Link
            key={contact.id}
            href={`/conversations/${contact.id}`}
            style={{ textDecoration: 'none' }}
            onClick={() => markRead(contact.id)}
          >
            <div
              className="conv-row"
              style={{
                background: badgeType ? '#fffdf5' : '#FFFFFF',
                borderRadius: '16px',
                padding: '16px 20px',
                boxShadow: borderColor
                  ? `0 1px 8px rgba(0,0,0,0.06), inset 3px 0 0 ${borderColor}`
                  : '0 1px 8px rgba(0,0,0,0.06)',
                transition: 'background 0.2s, box-shadow 0.2s',
                cursor: 'pointer',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
                <div>
                  <p style={{ fontSize: '15px', fontWeight: badgeType ? 800 : 700, color: '#000', margin: 0, display: 'flex', alignItems: 'center', gap: '7px' }}>
                    {badgeType && (
                      <span style={{
                        display: 'inline-block', width: '9px', height: '9px', borderRadius: '50%',
                        background: badgeType === 'red' ? '#E53935' : '#FF8C00', flexShrink: 0,
                      }} />
                    )}
                    {(contact.casino_username ?? '').trim()
                      || (contact.name ?? '').trim()
                      || contact.phone}
                  </p>
                  <p style={{ fontSize: '12px', color: '#999', margin: '2px 0 0 0' }}>{contact.phone}</p>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  {badgeType && pendingCount > 0 && (
                    <span style={{
                      background: badgeType === 'red' ? '#E53935' : '#FF8C00',
                      color: '#fff',
                      borderRadius: '999px',
                      fontSize: '11px',
                      fontWeight: 800,
                      minWidth: '20px',
                      height: '20px',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      padding: '0 6px',
                    }}>
                      {pendingCount > 99 ? '99+' : pendingCount}
                    </span>
                  )}
                  <span style={{
                    background: contact.status === 'cliente_activo' ? '#C8FF00'
                              : contact.status === 'inactivo'        ? '#888'
                              : '#F0F0F0',
                    color: contact.status === 'cliente_activo' ? '#000'
                         : contact.status === 'inactivo'        ? '#fff'
                         : '#888',
                    borderRadius: '999px',
                    padding: '4px 12px',
                    fontSize: '11px',
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                  }}>
                    {contact.status === 'cliente_activo' ? 'CLIENTE ACTIVO'
                   : contact.status === 'inactivo'        ? 'INACTIVO'
                   : contact.status === 'nuevo'           ? 'NUEVO'
                   : contact.status === 'bloqueado'       ? 'BLOQUEADO'
                   : (contact.status ?? '').toUpperCase()}
                  </span>
                </div>
              </div>

              {lastMessage && (
                <div className="conv-preview" style={{ marginTop: '12px', background: '#F5F5F5', borderRadius: '12px', padding: '10px 14px' }}>
                  <p style={{
                    fontSize: '13px',
                    color: badgeType ? '#333' : '#666',
                    fontWeight: badgeType ? 600 : 400,
                    margin: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}>
                    {lastMessage.content}
                  </p>
                  <p style={{ fontSize: '11px', color: '#bbb', margin: '4px 0 0 0' }} title={new Date(lastMessage.created_at).toLocaleString('es-AR')}>
                    {formatRelativeTime(lastMessage.created_at)}
                  </p>
                </div>
              )}
            </div>
          </Link>
        );
      })}
    </div>
  );
}
// v2
