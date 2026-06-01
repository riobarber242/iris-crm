"use client";

import React, { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { createClient } from '@supabase/supabase-js';

export default function ConversationsClient() {
  const [conversations,  setConversations]  = useState<any[]>([]);
  const [viewedContacts, setViewedContacts] = useState<Set<string>>(new Set());

  // ── Refs so the Realtime callbacks never go stale ──────────────────────────
  const fetchRef = useRef<() => void>(() => {});
  fetchRef.current = async () => {
    try {
      const res = await fetch('/api/conversations');
      if (!res.ok) return;
      setConversations(await res.json());
    } catch {}
  };

  // Optimistic INSERT handler: move contact to top immediately with the new
  // message prepended, then do a background refetch for accurate unread counts.
  const insertRef = useRef<(payload: any) => void>(() => {});
  insertRef.current = (payload: any) => {
    const contactId = payload.new?.contact_id as string | undefined;
    if (contactId) {
      setConversations(prev => {
        const idx = prev.findIndex(c => c.id === contactId);
        if (idx < 0) return prev; // contact not loaded yet — refetch handles it

        const copy = [...prev];
        const [contact] = copy.splice(idx, 1);
        const updatedContact = {
          ...contact,
          messages: [payload.new, ...(contact.messages ?? [])],
        };
        return [updatedContact, ...copy];
      });
    }
    // Background refetch for accurate data regardless of optimistic update
    fetchRef.current();
  };

  useEffect(() => {
    fetchRef.current();
    const timer = setInterval(() => fetchRef.current(), 15_000);

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key) return () => clearInterval(timer);

    const supabase = createClient(url, key);
    const ch = supabase.channel('conversations-live')
      .on('postgres_changes' as any,
        { event: 'INSERT', schema: 'public', table: 'messages' },
        (p: any) => insertRef.current(p))
      .on('postgres_changes' as any,
        { event: '*', schema: 'public', table: 'contacts' },
        () => fetchRef.current())
      .subscribe();

    return () => {
      clearInterval(timer);
      try { supabase.removeChannel(ch); } catch {}
    };
  }, []);

  // Mark contact as viewed → badge disappears instantly in this session
  function markViewed(contactId: string) {
    setViewedContacts(prev => new Set([...prev, contactId]));
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {conversations.map((contact) => {
        const messages: any[]  = contact.messages ?? [];
        const lastMessage      = messages[0];
        const alreadyViewed    = viewedContacts.has(contact.id);

        // Consecutive user messages from top = unread count
        // Badge is suppressed once the operator opens the conversation
        let unreadCount = 0;
        if (!alreadyViewed) {
          for (const msg of messages) {
            if (msg.role === 'user') unreadCount++;
            else break;
          }
        }
        const hasUnread = unreadCount > 0;

        return (
          <Link
            key={contact.id}
            href={`/conversations/${contact.id}`}
            style={{ textDecoration: 'none' }}
            onClick={() => markViewed(contact.id)}
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
                    {contact.name || contact.phone}
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
