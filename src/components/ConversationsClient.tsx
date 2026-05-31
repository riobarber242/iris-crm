"use client";

import React, { useEffect, useState, useRef } from 'react';
import Link from 'next/link';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

export default function ConversationsClient() {
  const [conversations, setConversations] = useState<any[]>([]);
  const supabaseRef = useRef<SupabaseClient | null>(null);
  const channelRef = useRef<any>(null);

  async function fetchConversations() {
    try {
      const res = await fetch('/api/conversations');
      if (!res.ok) return;
      setConversations(await res.json());
    } catch {}
  }

  useEffect(() => {
    fetchConversations();
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL as string | undefined;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string | undefined;
    if (!url || !key) return;
    supabaseRef.current = createClient(url, key);
    const channel = supabaseRef.current
      .channel('realtime-conversations')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'contacts' }, () => fetchConversations())
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, () => fetchConversations())
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages' }, () => fetchConversations())
      .subscribe();
    channelRef.current = channel;
    return () => {
      try { if (channelRef.current) supabaseRef.current?.removeChannel(channelRef.current); } catch {}
    };
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {conversations.map((contact) => {
        const lastMessage = contact.messages?.[0];
        return (
          <Link key={contact.id} href={`/conversations/${contact.id}`} style={{ textDecoration: 'none' }}>
            <div
              style={{
                background: '#FFFFFF',
                borderRadius: '16px',
                padding: '16px 20px',
                boxShadow: '0 1px 8px rgba(0,0,0,0.06)',
                transition: 'box-shadow 0.15s',
                cursor: 'pointer',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
                <div>
                  <p style={{ fontSize: '15px', fontWeight: 700, color: '#000', margin: 0 }}>
                    {contact.name || contact.phone}
                  </p>
                  <p style={{ fontSize: '12px', color: '#999', margin: '2px 0 0 0' }}>{contact.phone}</p>
                </div>
                <span
                  style={{
                    background: contact.status === 'activo' || contact.status === 'en_proceso' ? '#C8FF00' : '#F0F0F0',
                    color: contact.status === 'activo' || contact.status === 'en_proceso' ? '#000' : '#888',
                    borderRadius: '999px',
                    padding: '4px 12px',
                    fontSize: '11px',
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                  }}
                >
                  {contact.status}
                </span>
              </div>

              {lastMessage && (
                <div
                  style={{
                    marginTop: '12px',
                    background: '#F5F5F5',
                    borderRadius: '12px',
                    padding: '10px 14px',
                  }}
                >
                  <p style={{ fontSize: '13px', color: '#666', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
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
