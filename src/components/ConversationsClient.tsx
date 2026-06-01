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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {conversations.map((contact) => {
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
                  <p style={{ fontSize: '15px', fontWeight: badgeType ? 800 : 700, color: '#000', margin: 0 }}>
                    {contact.casino_username || contact.phone}
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
                    color: badgeType ? '#333' : '#666',
                    fontWeight: badgeType ? 600 : 400,
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
