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
      const data = await res.json();
      setConversations(data);
    } catch (e) {
      console.error(e);
    }
  }

  useEffect(() => {
    fetchConversations();

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL as string | undefined;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string | undefined;
    if (!url || !key) return;

    supabaseRef.current = createClient(url, key);

    const channel = supabaseRef.current
      .channel('realtime-conversations')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'contacts' }, () => {
        fetchConversations();
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, () => {
        fetchConversations();
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages' }, () => {
        fetchConversations();
      })
      .subscribe();

    channelRef.current = channel;

    return () => {
      try {
        if (channelRef.current) supabaseRef.current?.removeChannel(channelRef.current);
      } catch (e) {}
    };
  }, []);

  return (
    <div className="space-y-4">
      {conversations.map((contact) => {
        const lastMessage = contact.messages?.[0];
        return (
          <Link key={contact.id} href={`/conversations/${contact.id}`} className="block">
            <div className="rounded-[28px] border border-white/10 bg-[#14141c] p-5 hover:shadow-lg transition">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-lg font-semibold text-white">{contact.name || contact.phone}</p>
                  <p className="text-sm text-iris-text-muted">{contact.phone}</p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-sm text-iris-text-muted">{contact.status}</span>
                </div>
              </div>
              <div className="mt-4 flex flex-col gap-2 rounded-3xl bg-iris-card p-4">
                <p className="text-sm text-iris-text-muted">Último mensaje:</p>
                <p className="text-base text-white">{lastMessage ? lastMessage.content : 'Sin mensajes aún'}</p>
                <p className="text-xs text-iris-text-muted">{lastMessage ? new Date(lastMessage.created_at).toLocaleString('es-AR') : ''}</p>
              </div>
            </div>
          </Link>
        );
      })}
    </div>
  );
}
