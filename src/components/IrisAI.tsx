'use client';

import React, { useEffect, useRef, useState } from 'react';

type Msg = { role: 'user' | 'assistant'; content: string };

// Rayo SVG reutilizable. El color del relleno se controla por prop para poder
// animarlo en el estado "thinking".
function Bolt({ size = 26, fill = '#AAFF00' }: { size?: number; fill?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M13 2 L4 14 H11 L10 22 L20 9 H13 Z" fill={fill} stroke={fill} strokeWidth="0.5" strokeLinejoin="round" />
    </svg>
  );
}

export default function IrisAI() {
  const [open, setOpen] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<Msg[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, thinking, open]);

  async function send() {
    const text = input.trim();
    if (!text || thinking) return;
    const history = messages.slice(-20);
    const next = [...messages, { role: 'user' as const, content: text }];
    setMessages(next);
    setInput('');
    setThinking(true);
    try {
      const res = await fetch('/api/iris-ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, history }),
      });
      const d = await res.json().catch(() => ({}));
      const reply = res.ok ? (d.reply ?? '…') : (d.error ?? 'Error consultando a Iris AI.');
      setMessages((m) => [...m, { role: 'assistant', content: reply }]);
    } catch {
      setMessages((m) => [...m, { role: 'assistant', content: 'Error de red. Probá de nuevo.' }]);
    } finally {
      setThinking(false);
    }
  }

  return (
    <>
      <style>{`
        @keyframes iris-bolt-flash {
          0%   { color: #AAFF00; }
          25%  { color: #00E5FF; }
          50%  { color: #FF6B00; }
          75%  { color: #CCFF00; }
          100% { color: #AAFF00; }
        }
        @keyframes iris-bolt-pop {
          0%,100% { transform: scale(1); }
          50%     { transform: scale(1.14); }
        }
        .iris-thinking svg path { animation: iris-bolt-flash 0.9s linear infinite; fill: currentColor; stroke: currentColor; }
        .iris-thinking { animation: iris-bolt-pop 0.9s ease-in-out infinite; }
        @keyframes iris-dot { 0%,80%,100% { opacity: 0.25; } 40% { opacity: 1; } }
      `}</style>

      {/* Botón flotante */}
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="Abrir Iris AI"
        className={thinking ? 'iris-thinking' : ''}
        style={{
          position: 'fixed', bottom: '24px', right: '24px', zIndex: 1200,
          width: '60px', height: '60px', borderRadius: '50%',
          background: '#0a0a0a', border: '2px solid #AAFF00', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 6px 22px rgba(0,0,0,0.4)',
        }}
      >
        <Bolt size={28} />
      </button>

      {/* Overlay + Drawer */}
      {open && (
        <div
          onClick={() => setOpen(false)}
          style={{ position: 'fixed', inset: 0, zIndex: 1190, background: 'rgba(0,0,0,0.35)' }}
        />
      )}
      <aside
        style={{
          position: 'fixed', top: 0, right: 0, zIndex: 1200,
          height: '100vh', width: '380px', maxWidth: '92vw',
          background: '#FFFFFF', boxShadow: '-4px 0 24px rgba(0,0,0,0.18)',
          display: 'flex', flexDirection: 'column',
          transform: open ? 'translateX(0)' : 'translateX(105%)',
          transition: 'transform 0.25s ease',
        }}
      >
        {/* Header */}
        <header style={{ background: '#0a0a0a', padding: '16px 18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span className={thinking ? 'iris-thinking' : ''} style={{ display: 'flex' }}><Bolt size={24} /></span>
            <div>
              <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 900, color: '#fff' }}>Iris AI</h2>
              <p style={{ margin: 0, fontSize: '11px', color: '#aaa' }}>
                {thinking ? 'Pensando…' : 'Asistente de tu plataforma'}
              </p>
            </div>
          </div>
          <button
            onClick={() => setOpen(false)}
            aria-label="Cerrar"
            style={{ background: '#1a1a1a', color: '#fff', border: 'none', borderRadius: '8px', width: '32px', height: '32px', fontSize: '15px', cursor: 'pointer' }}
          >
            ✕
          </button>
        </header>

        {/* Mensajes */}
        <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '16px', background: '#F5F5F5', display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {messages.length === 0 && !thinking && (
            <div style={{ color: '#999', fontSize: '13px', textAlign: 'center', marginTop: '24px', lineHeight: 1.5 }}>
              Preguntame sobre tus datos en Iris.<br />
              Ej: <i>“¿cuántos contactos tengo?”</i>, <i>“top clientes”</i>, <i>“comprobantes pendientes”</i>.
            </div>
          )}
          {messages.map((m, i) => (
            <div
              key={i}
              style={{
                alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
                maxWidth: '85%',
                background: m.role === 'user' ? '#C8FF00' : '#fff',
                color: '#111',
                borderRadius: '14px',
                padding: '9px 13px',
                fontSize: '13px',
                lineHeight: 1.45,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
              }}
            >
              {m.content}
            </div>
          ))}
          {thinking && (
            <div style={{ alignSelf: 'flex-start', background: '#fff', borderRadius: '14px', padding: '11px 14px', boxShadow: '0 1px 4px rgba(0,0,0,0.06)', display: 'flex', gap: '4px' }}>
              {[0, 1, 2].map((i) => (
                <span key={i} style={{ width: '7px', height: '7px', borderRadius: '50%', background: '#888', animation: `iris-dot 1.2s ${i * 0.2}s infinite ease-in-out` }} />
              ))}
            </div>
          )}
        </div>

        {/* Input */}
        <div style={{ borderTop: '1px solid #eee', padding: '12px', display: 'flex', gap: '8px', flexShrink: 0, background: '#fff' }}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder="Escribí tu pregunta…"
            disabled={thinking}
            style={{ flex: 1, background: '#F5F5F5', border: '2px solid #eee', borderRadius: '12px', padding: '10px 12px', fontSize: '13px', color: '#111', outline: 'none' }}
          />
          <button
            onClick={send}
            disabled={thinking || !input.trim()}
            aria-label="Enviar"
            style={{
              background: thinking || !input.trim() ? '#e6e6e6' : '#0a0a0a',
              border: 'none', borderRadius: '12px', width: '44px', flexShrink: 0,
              cursor: thinking || !input.trim() ? 'not-allowed' : 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <Bolt size={20} fill={thinking || !input.trim() ? '#999' : '#AAFF00'} />
          </button>
        </div>
      </aside>
    </>
  );
}
