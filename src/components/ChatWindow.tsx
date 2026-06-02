"use client";

import React, { useEffect, useState, useRef } from 'react';
import { formatRelativeTime } from '@/lib/formatRelativeTime';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

type Message = {
  id?: string;
  contact_id?: string;
  role: string;
  content: string;
  created_at?: string;
  status?: string;
};

type QuickReply = { id: string; title: string; content: string };

type ImageContent = { _type: 'image'; url: string; caption: string };

function parseImageContent(raw: string): ImageContent | null {
  try {
    const p = JSON.parse(raw);
    if (p?._type === 'image' && typeof p.url === 'string') return p as ImageContent;
  } catch {}
  return null;
}

export default function ChatWindow({ contactId }: { contactId: string }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [cooldown, setCooldown] = useState(false);
  const [quickReplies, setQuickReplies] = useState<QuickReply[]>([]);
  const [showQR, setShowQR] = useState(false);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const supabaseRef = useRef<SupabaseClient | null>(null);
  const channelRef = useRef<any>(null);
  const qrPanelRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  async function fetchMessages() {
    try {
      const res = await fetch(`/api/messages?contactId=${contactId}`);
      if (!res.ok) return;
      setMessages((await res.json()).reverse());
    } catch {}
  }

  useEffect(() => {
    fetch('/api/quick-replies')
      .then((r) => r.json())
      .then((data) => { if (Array.isArray(data)) setQuickReplies(data); })
      .catch(() => {});
  }, []);

  // Close quick-reply panel on outside click
  useEffect(() => {
    if (!showQR) return;
    function handleClick(e: MouseEvent) {
      if (qrPanelRef.current && !qrPanelRef.current.contains(e.target as Node)) {
        setShowQR(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showQR]);

  useEffect(() => {
    fetchMessages();
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL as string | undefined;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string | undefined;
    if (!url || !key) return;
    supabaseRef.current = createClient(url, key);
    try {
      const channel = supabaseRef.current
        .channel(`messages:contact:${contactId}`)
        .on('postgres_changes', {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `contact_id=eq.${contactId}`,
        }, (payload: any) => {
          setMessages((m) => {
            if (payload.new.id && m.some((msg) => msg.id === payload.new.id)) return m;
            return [...m, payload.new];
          });
          setTimeout(() => {
            if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
          }, 50);
        })
        .subscribe();
      channelRef.current = channel;
    } catch {}
    return () => {
      try { if (channelRef.current) supabaseRef.current?.removeChannel(channelRef.current); } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactId]);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    fetch('/api/messages/mark-read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contactId }),
    }).catch(() => {});
  }, [contactId]);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    if (!file) return;
    setImageFile(file);
    setImagePreview(URL.createObjectURL(file));
    // Reset so same file can be re-selected
    e.target.value = '';
  }

  function clearImage() {
    setImageFile(null);
    if (imagePreview) URL.revokeObjectURL(imagePreview);
    setImagePreview(null);
  }

  async function handleSend(e?: React.FormEvent) {
    e?.preventDefault();
    if (loading || cooldown) return;

    if (imageFile) {
      await handleSendImage();
    } else {
      await handleSendText();
    }
  }

  async function handleSendText() {
    const content = input.trim();
    if (!content) return;

    setInput('');
    setLoading(true);
    setCooldown(true);

    const temp: Message = { role: 'human', content, status: 'sending' };
    setMessages((m) => [...m, temp]);

    try {
      const res = await fetch('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactId, content }),
      });
      if (res.ok) {
        const saved = await res.json();
        setMessages((m) => m.map((msg) => (msg === temp ? saved : msg)));
      } else {
        setMessages((m) => m.map((msg) => (msg === temp ? { ...msg, status: 'failed' } : msg)));
      }
    } catch {
      setMessages((m) => m.map((msg) => (msg === temp ? { ...msg, status: 'failed' } : msg)));
    }

    setLoading(false);
    setTimeout(() => setCooldown(false), 2000);
  }

  async function handleSendImage() {
    if (!imageFile) return;

    const caption = input.trim();
    const preview = imagePreview;

    setImageFile(null);
    setImagePreview(null);
    setInput('');
    setLoading(true);
    setCooldown(true);

    const tempContent = JSON.stringify({ _type: 'image', url: preview ?? '', caption });
    const temp: Message = { role: 'human', content: tempContent, status: 'sending' };
    setMessages((m) => [...m, temp]);

    const form = new FormData();
    form.append('file', imageFile);
    form.append('contactId', contactId);
    form.append('caption', caption);

    try {
      const res = await fetch('/api/messages/image', { method: 'POST', body: form });
      if (res.ok) {
        const saved = await res.json();
        setMessages((m) => m.map((msg) => (msg === temp ? saved : msg)));
      } else {
        setMessages((m) => m.map((msg) => (msg === temp ? { ...msg, status: 'failed' } : msg)));
      }
    } catch {
      setMessages((m) => m.map((msg) => (msg === temp ? { ...msg, status: 'failed' } : msg)));
    }

    if (preview) URL.revokeObjectURL(preview);
    setLoading(false);
    setTimeout(() => setCooldown(false), 2000);
  }

  return (
    <div
      style={{
        background: '#FFFFFF',
        borderRadius: '20px',
        padding: '20px',
        boxShadow: '0 2px 16px rgba(0,0,0,0.07)',
      }}
    >
      {/* Message list */}
      <div
        ref={listRef}
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
          maxHeight: '60vh',
          overflowY: 'auto',
          paddingRight: '4px',
          marginBottom: '16px',
        }}
      >
        {messages.map((m, i) => {
          const isBot   = m.role === 'assistant';
          const isHuman = m.role === 'human';
          const roleLabel = isBot ? 'Iris 🤖' : isHuman ? 'Operador' : 'Cliente';
          const img = parseImageContent(m.content);
          return (
            <div
              key={m.id ?? i}
              style={{
                maxWidth: '78%',
                alignSelf: isBot ? 'flex-start' : 'flex-end',
                background: isBot ? '#F0F0F0' : isHuman ? '#C8FF00' : '#1a1a1a',
                color: isBot ? '#333' : isHuman ? '#000' : '#fff',
                borderRadius: isBot ? '4px 16px 16px 16px' : '16px 4px 16px 16px',
                padding: '10px 14px',
                wordBreak: 'break-word',
              }}
            >
              <p style={{ fontSize: '11px', fontWeight: 600, opacity: 0.6, margin: '0 0 4px 0' }}>
                {roleLabel}{m.status && m.status !== 'sent' ? ` · ${m.status}` : ''}
              </p>
              {img ? (
                <div>
                  <img
                    src={img.url}
                    alt={img.caption || 'imagen'}
                    style={{ maxWidth: '100%', borderRadius: '10px', display: 'block', cursor: 'pointer' }}
                    onClick={() => window.open(img.url, '_blank')}
                  />
                  {img.caption && (
                    <p style={{ margin: '6px 0 0 0', fontSize: '14px', lineHeight: 1.5 }}>{img.caption}</p>
                  )}
                </div>
              ) : (
                <p style={{ margin: 0, fontSize: '14px', lineHeight: 1.5 }}>{m.content}</p>
              )}
              {m.created_at && (
                <p style={{ margin: '6px 0 0 0', fontSize: '11px', opacity: 0.5 }} title={new Date(m.created_at).toLocaleString('es-AR')}>
                  {formatRelativeTime(m.created_at)}
                </p>
              )}
            </div>
          );
        })}
      </div>

      {/* Input area */}
      <div style={{ position: 'relative' }} ref={qrPanelRef}>
        {/* Quick-reply panel */}
        {showQR && (
          <div
            style={{
              position: 'absolute',
              bottom: 'calc(100% + 8px)',
              left: 0,
              right: 0,
              background: '#fff',
              borderRadius: '16px',
              boxShadow: '0 4px 24px rgba(0,0,0,0.13)',
              padding: '8px',
              zIndex: 50,
              maxHeight: '240px',
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: '4px',
            }}
          >
            {quickReplies.length === 0 ? (
              <p style={{ fontSize: '13px', color: '#999', padding: '10px 12px', margin: 0 }}>
                No hay respuestas rápidas. Creá una en Configuración.
              </p>
            ) : (
              quickReplies.map((qr) => (
                <button
                  key={qr.id}
                  type="button"
                  onClick={() => { setInput(qr.content); setShowQR(false); }}
                  style={{
                    background: 'none',
                    border: 'none',
                    borderRadius: '10px',
                    padding: '10px 14px',
                    textAlign: 'left',
                    cursor: 'pointer',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = '#F5F5F5')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
                >
                  <p style={{ fontSize: '11px', fontWeight: 700, color: '#C8FF00', margin: '0 0 2px 0', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                    {qr.title}
                  </p>
                  <p style={{ fontSize: '13px', color: '#333', margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {qr.content}
                  </p>
                </button>
              ))
            )}
          </div>
        )}

        {/* Image preview strip */}
        {imagePreview && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              background: '#F5F5F5',
              borderRadius: '14px',
              padding: '10px 14px',
              marginBottom: '10px',
            }}
          >
            <img
              src={imagePreview}
              alt="preview"
              style={{ width: '56px', height: '56px', objectFit: 'cover', borderRadius: '8px', flexShrink: 0 }}
            />
            <p style={{ fontSize: '13px', color: '#555', margin: 0, flex: 1 }}>
              {imageFile?.name}
            </p>
            <button
              type="button"
              onClick={clearImage}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#999', fontSize: '20px', lineHeight: 1, padding: '4px' }}
            >
              ×
            </button>
          </div>
        )}

        <form onSubmit={handleSend} style={{ display: 'flex', gap: '10px' }}>
          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={handleFileChange}
          />

          {/* Quick-replies toggle */}
          <button
            type="button"
            onClick={() => setShowQR((v) => !v)}
            title="Respuestas rápidas"
            style={{
              background: showQR ? '#C8FF00' : '#F5F5F5',
              border: 'none',
              borderRadius: '12px',
              padding: '12px 14px',
              fontSize: '16px',
              cursor: 'pointer',
              flexShrink: 0,
              lineHeight: 1,
            }}
          >
            ⚡
          </button>

          {/* Image attach button */}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            title="Adjuntar imagen"
            style={{
              background: imageFile ? '#C8FF00' : '#F5F5F5',
              border: 'none',
              borderRadius: '12px',
              padding: '12px 14px',
              fontSize: '16px',
              cursor: 'pointer',
              flexShrink: 0,
              lineHeight: 1,
            }}
          >
            📎
          </button>

          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={imageFile ? 'Agregar descripción (opcional)...' : 'Escribí un mensaje...'}
            style={{
              flex: 1,
              background: '#F5F5F5',
              border: 'none',
              borderRadius: '12px',
              padding: '12px 16px',
              fontSize: '14px',
              color: '#1a1a1a',
              outline: 'none',
            }}
          />

          <button
            type="submit"
            disabled={loading || cooldown || (!input.trim() && !imageFile)}
            style={{
              background: loading || cooldown || (!input.trim() && !imageFile) ? '#e0e0e0' : '#C8FF00',
              color: '#000',
              fontWeight: 700,
              fontSize: '14px',
              border: 'none',
              borderRadius: '12px',
              padding: '12px 20px',
              cursor: loading || cooldown || (!input.trim() && !imageFile) ? 'not-allowed' : 'pointer',
              opacity: loading || cooldown || (!input.trim() && !imageFile) ? 0.6 : 1,
              boxShadow: loading || cooldown || (!input.trim() && !imageFile) ? 'none' : '0 4px 12px rgba(200,255,0,0.3)',
            }}
          >
            {loading ? '...' : cooldown ? '✓' : 'Enviar'}
          </button>
        </form>
      </div>
    </div>
  );
}
