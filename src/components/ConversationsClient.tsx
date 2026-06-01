"use client";

import React, { useState, useEffect } from 'react';
import Link from 'next/link';

export default function ConversationsClient() {
  const [conversations, setConversations] = useState<any[]>([]);

  async function fetchConversations() {
    try {
      const res = await fetch('/api/conversations');
      if (!res.ok) return;
      setConversations(await res.json());
    } catch {}
  }

  // Simple polling every 5 s — reliable, no Realtime complexity
  useEffect(() => {
    fetchConversations();
    const timer = setInterval(fetchConversations, 5_000);
    return () => clearInterval(timer);
  }, []);

  // Persist last_read_at to DB and clear badge optimistically in local state
  function markRead(contactId: string) {
    setConversations(prev =>
      prev.map(c =>
        c.id === contactId
          ? { ...c, last_read_at: new Date().toISOString() }
          : c,
      ),
    );
    fetch('/api/conversations', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contactId, markRead: true }),
    }).catch(() => {});
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {conversations.map((contact) => {
        const messages: any[] = contact.messages ?? [];
        const lastMessage     = messages[0];
        const lastReadAt      = contact.last_read_at ? new Date(contact.last_read_at) : null;

        // Count user messages received AFTER last_read_at.
        // If last_read_at is null (never opened), treat as fully read — no badge.
        let unreadCount = 0;
        if (lastReadAt) {
          for (const msg of messages) {
            if (msg.role === 'user' && new Date(msg.created_at) > lastReadAt) {
              unreadCount++;
            }
          }
        }
        const hasUnread = unreadCount > 0;

        return (
          <Link
            key={contact.id}
            href={`/conversations/${contact.id}`}
            style={{ textDecoration: 'none' }}
            onClick={() => markRead(contact.id)}
          >
            <div
              style={{
                background: hasUnread ? '#fffef5' : '#FFFFFF',
                borderRadius: '16px',
                padding: '16px 20px',
                boxShadow: hasUnread
                  ? '0 1px 8px rgba(0,0,0,0.06), inset 3px 0 0 #C8FF00'
                  : '0 1px 8px rgba(0,0,0,0.06)',
                transition: 'background 0.2s, box-shadow 0.2s',
                cursor: 'pointer',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
                <div>
                  <p style={{ fontSize: '15px', fontWeight: hasUnread ? 800 : 700, color: '#000', margin: 0 }}>
                    {contact.casino_username || contact.phone}
                  </p>
                  <p style={{ fontSize: '12px', color: '#999', margin: '2px 0 0 0' }}>{contact.phone}</p>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  {hasUnread && (
                    <span style={{
                      background: '#25D366',
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
                      {unreadCount > 99 ? '99+' : unreadCount}
                    </span>
                  )}
                  <span style={{
                    background: contact.status === 'activo' || contact.status === 'en_proceso'
                      ? '#C8FF00' : '#F0F0F0',
                    color: contact.status === 'activo' || contact.status === 'en_proceso'
                      ? '#000' : '#888',
                    borderRadius: '999px',
                    padding: '4px 12px',
                    fontSize: '11px',
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                  }}>
                    {contact.status}
                  </span>
                </div>
              </div>

              {lastMessage && (
                <div style={{ marginTop: '12px', background: '#F5F5F5', borderRadius: '12px', padding: '10px 14px' }}>
                  <p style={{
                    fontSize: '13px',
                    color: hasUnread ? '#333' : '#666',
                    fontWeight: hasUnread ? 600 : 400,
                    margin: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}>
                    {lastMessage.content}
                  </p>
                  <p style={{ fontSize: '11px', color: '#bbb', margin: '4px 0 0 0' }}>
                    {new Date(lastMessage.created_at).toLocaleString('es-AR')}
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
