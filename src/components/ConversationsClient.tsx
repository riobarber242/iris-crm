"use client";

import React, { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { createClient } from '@supabase/supabase-js';
import { formatRelativeTime } from '@/lib/formatRelativeTime';

function playNotificationBeep() {
  try {
    const ctx  = new (window.AudioContext || (window as any).webkitAudioContext)();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type            = 'sine';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.25, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.35);
  } catch {}
}

export default function ConversationsClient() {
  const [conversations,  setConversations]  = useState<any[]>([]);
  const [activeFilter,   setActiveFilter]   = useState<'todos' | 'nuevo' | 'cliente_activo' | 'inactivo' | 'bloqueado'>('todos');
  const [query,          setQuery]          = useState('');
  // Tracks the latest inbound message timestamp seen, to detect new arrivals
  const latestMsgTsRef = useRef<string | null>(null);
  const fetchRef       = useRef<() => void>(() => {});
  const sbRef          = useRef<any>(null);
  const channelRef     = useRef<any>(null);

  async function fetchConversations() {
    try {
      const res = await fetch('/api/conversations');
      if (!res.ok) return;
      const data: any[] = await res.json();

      // Detect new inbound messages → play beep
      // Find the most recent user message across all conversations
      let newestTs: string | null = null;
      for (const c of data) {
        const msgs: any[] = c.messages ?? [];
        const latestInbound = msgs.find((m: any) => m.role === 'user');
        if (latestInbound?.created_at) {
          if (!newestTs || latestInbound.created_at > newestTs) {
            newestTs = latestInbound.created_at;
          }
        }
      }
      if (newestTs && latestMsgTsRef.current && newestTs > latestMsgTsRef.current) {
        playNotificationBeep();
      }
      if (newestTs) latestMsgTsRef.current = newestTs;

      setConversations(data);
    } catch {}
  }

  // Realtime (mensajes + contactos) con polling de respaldo cada 5 s.
  useEffect(() => {
    fetchRef.current = fetchConversations;
    fetchConversations();
    const timer = setInterval(() => fetchRef.current(), 5_000);

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL as string | undefined;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string | undefined;
    if (url && key) {
      const sb = createClient(url, key);
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
      try { if (channelRef.current) sbRef.current?.removeChannel(channelRef.current); } catch {}
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

  const filtered = conversations.filter((c) => {
    if (activeFilter === 'bloqueado')      { if (c.blocked !== true) return false; }
    else if (activeFilter !== 'todos')     { if (c.status?.toLowerCase() !== activeFilter) return false; }

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

      {/* Search */}
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Buscar por usuario casino, nombre o teléfono..."
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

      {/* Filter bar */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '4px', flexWrap: 'wrap' }}>
        {FILTERS.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setActiveFilter(key)}
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

      {filtered.length === 0 && (
        <div style={{ textAlign: 'center', padding: '40px 0', color: '#bbb', fontSize: '14px' }}>
          {query.trim()
            ? `Sin resultados para "${query}".`
            : activeFilter !== 'todos'
              ? `No hay conversaciones con estado "${activeFilter}".`
              : 'No hay conversaciones.'}
        </div>
      )}

      {filtered.map((contact) => {
        const messages: any[] = contact.messages ?? [];
        const lastMessage     = messages[0];
        const lastMsgInbound  = lastMessage?.role === 'user';
        const hasCasinoUser   = !!contact.casino_username;
        const botFlowDone     = contact.conversation_state === 'done'
                              || contact.conversation_state === 'en_proceso'
                              || contact.status === 'en_proceso';

        // Badge clears when operator opened the conversation AFTER the last message
        // markRead() sets last_read_at = NOW() optimistically, which triggers this
        const lastReadAt   = contact.last_read_at ? new Date(contact.last_read_at) : null;
        const lastMsgTime  = lastMessage ? new Date(lastMessage.created_at) : null;
        const readAfterMsg = !!(lastReadAt && lastMsgTime && lastReadAt >= lastMsgTime);

        // Count consecutive inbound messages from top (unanswered)
        let pendingCount = 0;
        for (const msg of messages) {
          if (msg.role === 'user') pendingCount++;
          else break;
        }

        // Badge type based on business rules — clears once conversation is opened
        // 🟠 Orange: new contact, bot finished, operator's turn
        // 🔴 Red: recurring (has casino_username), waiting for manual reply
        let badgeType: 'orange' | 'red' | null = null;
        if (lastMsgInbound && pendingCount > 0 && !readAfterMsg) {
          if (hasCasinoUser)    badgeType = 'red';
          else if (botFlowDone) badgeType = 'orange';
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
                  {badgeType && (
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
                <div style={{ marginTop: '12px', background: '#F5F5F5', borderRadius: '12px', padding: '10px 14px' }}>
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
