"use client";

import React, { useEffect, useState, useRef } from 'react';

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
  const mounted = useRef(false);

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
    mounted.current = true;
    const iv = setInterval(fetchMessages, 3000);
    return () => {
      mounted.current = false;
      clearInterval(iv);
    };
  }, [contactId]);

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
      <div className="space-y-3 max-h-[60vh] overflow-auto p-2">
        {messages.map((m, i) => (
          <div key={m.id ?? i} className={`p-3 rounded-md ${m.role === 'assistant' ? 'bg-iris-card' : 'bg-[#0f1724]'}`}>
            <p className="text-xs text-iris-text-muted">{m.role} {m.status ? `• ${m.status}` : ''}</p>
            <p className="text-white">{m.content}</p>
            <p className="text-xs text-iris-text-muted">{m.created_at ? new Date(m.created_at).toLocaleString('es-AR') : ''}</p>
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
