
"use client";

import React, { useEffect, useState, useRef } from 'react';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

type Message = {
  id?: string;
  contact_id?: string;
  role: string;
  content: string;
  created_at?: string;
  status?: string;
};

export default function ChatWindow({ contactId }: { contactId: string }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const supabaseRef = useRef<SupabaseClient | null>(null);
  const channelRef = useRef<any>(null);

  async function fetchMessages() {
    try {
      const res = await fetch(`/api/messages?contactId=${contactId}`);
      if (!res.ok) return;
      const data = await res.json();
      setMessages(data.reverse());
    } catch (err) {
      console.error(err);
    }
  }

  useEffect(() => {
    fetchMessages();

    // Setup Supabase Realtime subscription
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL as string | undefined;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string | undefined;
    if (!url || !key) return;

    supabaseRef.current = createClient(url, key);

    try {
      const channel = supabaseRef.current
        .channel(`messages:contact:${contactId}`)
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'messages', filter: `contact_id=eq.${contactId}` },
          (payload: any) => {
            setMessages((m) => [...m, payload.new]);
            // scroll to bottom
            setTimeout(() => {
              if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
            }, 50);
          }
        )
        .subscribe();

      channelRef.current = channel;
    } catch (err) {
      console.error('Realtime subscribe error', err);
    }

    return () => {
      try {
        if (channelRef.current) {
          supabaseRef.current?.removeChannel(channelRef.current);
        }
      } catch (err) {
        // ignore
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactId]);

  useEffect(() => {
    // scroll to bottom when messages change
    if (listRef.current) {
      listRef.current.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
    }
  }, [messages]);

  async function handleSend(e?: React.FormEvent) {
    e?.preventDefault();
    if (!input.trim()) return;
    const temp: Message = { role: 'human', content: input.trim(), status: 'sending' };
    setMessages((m) => [...m, temp]);
    setLoading(true);
    setInput('');

    try {
      const res = await fetch('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactId, content: temp.content }),
      });
      if (res.ok) {
        const saved = await res.json();
        setMessages((m) => m.map((msg) => (msg === temp ? saved : msg)));
      } else {
        console.error('Failed to send message');
        setMessages((m) => m.map((msg) => (msg === temp ? { ...msg, status: 'failed' } : msg)));
      }
    } catch (err) {
      console.error(err);
      setMessages((m) => m.map((msg) => (msg === temp ? { ...msg, status: 'failed' } : msg)));
    }

    setLoading(false);
  }

  return (
    <div>
      <div ref={listRef} className="space-y-3 max-h-[60vh] overflow-auto p-2">
        {messages.map((m, i) => (
          <div
            key={m.id ?? i}
            className={`max-w-[80%] p-3 rounded-2xl ${m.role === 'assistant' ? 'ml-0 bg-iris-card self-start' : 'ml-auto bg-[#0b1220] self-end'} break-words`}
          >
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-iris-text-muted capitalize">{m.role}</p>
              {m.status ? <p className="text-xs text-iris-text-muted">{m.status}</p> : null}
            </div>
            <p className="text-white mt-1">{m.content}</p>
            <p className="text-xs text-iris-text-muted mt-2">{m.created_at ? new Date(m.created_at).toLocaleString('es-AR') : ''}</p>
          </div>
        ))}
      </div>

      <form onSubmit={handleSend} className="mt-4 flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          className="flex-1 rounded-xl bg-[#0b0b11] p-3 text-white"
          placeholder="Escribí un mensaje..."
        />
        <button type="submit" disabled={loading} className="rounded-xl bg-iris-pink px-4 py-2 text-white">
          {loading ? 'Enviando...' : 'Enviar'}
        </button>
      </form>
    </div>
  );
}
