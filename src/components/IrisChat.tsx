'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';

// ── Chat flotante de Iris AI ──────────────────────────────────────────────
// Burbuja flotante (draggable con mouse y touch; tap para abrir) que abre un
// panel de chat. En todos los dispositivos el panel es draggable (desde el
// header) y redimensionable (handle arriba-izq), con botón maximizar/restaurar
// (pantalla completa) y minimizar a burbuja. Posición y tamaño se persisten en
// localStorage.
// El chat reusa el backend con herramientas de /api/iris-ai (datos reales del
// CRM del tenant). El audio se transcribe en /api/iris/transcribe (Groq Whisper)
// y la transcripción se manda automáticamente como mensaje de texto.

type Msg = {
  id: string;
  role: 'user' | 'assistant';
  content?: string;
  audioUrl?: string;
  transcript?: string;
  transcribing?: boolean;
};

const MIN_W = 320, MIN_H = 420, MAX_W = 600, MAX_H = 700;
const DEFAULT_SIZE = { width: 384, height: 560 };
const DEFAULT_POS = { right: 24, bottom: 24 };
const MOBILE_BP = 768;
const DRAG_THRESHOLD = 8;        // px (mouse): menos = tap (abre el chat), más = drag
const TOUCH_DRAG_THRESHOLD = 12; // px (touch): umbral más alto para no confundir tap con drag
const MAX_Z = 2147483000; // z-index para pantalla completa (por encima de todo)

const ORANGE = '#F97316';
const DARK = '#0a0a0a';

let _seq = 0;
const uid = () => `${Date.now()}-${_seq++}`;
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

function Bolt({ size = 24, fill = '#AAFF00' }: { size?: number; fill?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M13 2 L4 14 H11 L10 22 L20 9 H13 Z" fill={fill} stroke={fill} strokeWidth="0.5" strokeLinejoin="round" />
    </svg>
  );
}

export default function IrisChat() {
  const [open, setOpen] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [pos, setPos] = useState(DEFAULT_POS);
  const [size, setSize] = useState(DEFAULT_SIZE);

  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<Msg[]>([]);
  const [thinking, setThinking] = useState(false);
  const [recording, setRecording] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesRef = useRef<Msg[]>([]);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => { messagesRef.current = messages; }, [messages]);

  // Textarea estilo WhatsApp: crece de 1 línea hasta ~5 (120px), luego scroll.
  useEffect(() => {
    const el = inputRef.current;
    if (el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 120) + 'px'; }
  }, [input]);

  // ── Cargar posición/tamaño persistidos (o tamaño inicial según viewport) ──
  useEffect(() => {
    try {
      const p = localStorage.getItem('iris-chat-pos');
      if (p) {
        const v = JSON.parse(p);
        if (typeof v?.right === 'number' && typeof v?.bottom === 'number') setPos(v);
      }
    } catch {}

    let loaded = false;
    try {
      const s = localStorage.getItem('iris-chat-size');
      if (s) {
        const v = JSON.parse(s);
        if (typeof v?.width === 'number' && typeof v?.height === 'number') {
          setSize({ width: clamp(v.width, MIN_W, MAX_W), height: clamp(v.height, MIN_H, MAX_H) });
          loaded = true;
        }
      }
    } catch {}

    // Sin tamaño guardado: en pantallas chicas arrancamos a ~85vw × 65vh.
    if (!loaded && window.innerWidth < MOBILE_BP) {
      setSize({
        width:  clamp(Math.round(window.innerWidth * 0.85), MIN_W, MAX_W),
        height: clamp(Math.round(window.innerHeight * 0.65), MIN_H, MAX_H),
      });
    }
  }, []);

  useEffect(() => { try { localStorage.setItem('iris-chat-pos', JSON.stringify(pos)); } catch {} }, [pos]);
  useEffect(() => { try { localStorage.setItem('iris-chat-size', JSON.stringify(size)); } catch {} }, [size]);

  // ── Autoscroll ──
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, thinking, open, maximized]);

  // ── Gesto de arrastre unificado (mouse + touch) ──
  // Mueve el ancla abajo-derecha (pos). onTap se dispara si el movimiento total
  // fue menor a DRAG_THRESHOLD (para distinguir tap de drag en la burbuja).
  const startDrag = useCallback((sx: number, sy: number, opts: { elW: number; elH: number; onTap?: () => void; threshold?: number }) => {
    const startRight = pos.right, startBottom = pos.bottom;
    let moved = 0;
    const apply = (cx: number, cy: number) => {
      const dx = cx - sx, dy = cy - sy;
      moved = Math.max(moved, Math.hypot(dx, dy));
      setPos({
        right:  clamp(startRight - dx, 0, Math.max(0, window.innerWidth - opts.elW)),
        bottom: clamp(startBottom - dy, 0, Math.max(0, window.innerHeight - opts.elH)),
      });
    };
    const mm = (ev: MouseEvent) => apply(ev.clientX, ev.clientY);
    const tm = (ev: TouchEvent) => { const t = ev.touches[0]; if (t) { apply(t.clientX, t.clientY); ev.preventDefault(); } };
    const end = () => {
      document.removeEventListener('mousemove', mm);
      document.removeEventListener('mouseup', end);
      document.removeEventListener('touchmove', tm);
      document.removeEventListener('touchend', end);
      document.removeEventListener('touchcancel', end);
      if (moved < (opts.threshold ?? DRAG_THRESHOLD)) opts.onTap?.();
    };
    document.addEventListener('mousemove', mm);
    document.addEventListener('mouseup', end);
    document.addEventListener('touchmove', tm, { passive: false });
    document.addEventListener('touchend', end);
    document.addEventListener('touchcancel', end);
  }, [pos]);

  // ── Gesto de resize unificado (handle arriba-izq; panel anclado abajo-der) ──
  const startResize = useCallback((sx: number, sy: number) => {
    const startW = size.width, startH = size.height;
    const apply = (cx: number, cy: number) => {
      setSize({
        width:  clamp(startW - (cx - sx), MIN_W, MAX_W),
        height: clamp(startH - (cy - sy), MIN_H, MAX_H),
      });
    };
    const mm = (ev: MouseEvent) => apply(ev.clientX, ev.clientY);
    const tm = (ev: TouchEvent) => { const t = ev.touches[0]; if (t) { apply(t.clientX, t.clientY); ev.preventDefault(); } };
    const end = () => {
      document.removeEventListener('mousemove', mm);
      document.removeEventListener('mouseup', end);
      document.removeEventListener('touchmove', tm);
      document.removeEventListener('touchend', end);
      document.removeEventListener('touchcancel', end);
    };
    document.addEventListener('mousemove', mm);
    document.addEventListener('mouseup', end);
    document.addEventListener('touchmove', tm, { passive: false });
    document.addEventListener('touchend', end);
    document.addEventListener('touchcancel', end);
  }, [size]);

  // ── Llamada al backend de Iris (reusa /api/iris-ai con herramientas) ──
  async function callIris(text: string, prior: Msg[]): Promise<string> {
    const history = prior
      .map((m) => ({ role: m.role, content: m.content ?? m.transcript ?? '' }))
      .filter((m) => m.content)
      .slice(-20);
    const res = await fetch('/api/iris-ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, history }),
    });
    const d = await res.json().catch(() => ({}));
    return res.ok ? (d.reply ?? '…') : (d.error ?? 'Error consultando a Iris AI.');
  }

  async function handleSendText() {
    const text = input.trim();
    if (!text || thinking) return;
    const prior = messagesRef.current;
    setMessages((m) => [...m, { id: uid(), role: 'user', content: text }]);
    setInput('');
    setThinking(true);
    try {
      const reply = await callIris(text, prior);
      setMessages((m) => [...m, { id: uid(), role: 'assistant', content: reply }]);
    } catch {
      setMessages((m) => [...m, { id: uid(), role: 'assistant', content: 'Error de red. Probá de nuevo.' }]);
    } finally {
      setThinking(false);
    }
  }

  // ── Grabación de audio ──
  async function toggleRecording() {
    if (recording) { stopRecording(); return; }
    if (thinking) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mr = new MediaRecorder(stream);
      chunksRef.current = [];
      mr.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mr.onstop = handleRecordingStop;
      mediaRecorderRef.current = mr;
      mr.start();
      setRecording(true);
    } catch {
      setMessages((m) => [...m, { id: uid(), role: 'assistant', content: 'No pude acceder al micrófono. Revisá los permisos del navegador.' }]);
    }
  }

  function stopRecording() {
    const mr = mediaRecorderRef.current;
    if (mr && mr.state !== 'inactive') mr.stop();
    setRecording(false);
  }

  async function handleRecordingStop() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;

    const mime = mediaRecorderRef.current?.mimeType || 'audio/webm';
    const blob = new Blob(chunksRef.current, { type: mime });
    chunksRef.current = [];
    if (blob.size === 0) return;

    const audioUrl = URL.createObjectURL(blob);
    const msgId = uid();
    const prior = messagesRef.current;
    setMessages((m) => [...m, { id: msgId, role: 'user', audioUrl, transcribing: true }]);

    try {
      const ext = mime.includes('ogg') ? 'ogg' : 'webm';
      const fd = new FormData();
      fd.append('audio', blob, `audio.${ext}`);
      const res = await fetch('/api/iris/transcribe', { method: 'POST', body: fd });
      const d = await res.json().catch(() => ({}));
      const text = res.ok ? String(d.text ?? '').trim() : '';

      setMessages((m) => m.map((x) => (x.id === msgId ? { ...x, transcribing: false, transcript: text || '(sin transcripción)' } : x)));

      if (text) {
        setThinking(true);
        try {
          const reply = await callIris(text, [...prior, { id: msgId, role: 'user', transcript: text }]);
          setMessages((m) => [...m, { id: uid(), role: 'assistant', content: reply }]);
        } finally {
          setThinking(false);
        }
      }
    } catch {
      setMessages((m) => m.map((x) => (x.id === msgId ? { ...x, transcribing: false, transcript: 'Error al transcribir.' } : x)));
    }
  }

  // Posición por defecto según viewport (mobile deja un poco más de margen lateral).
  function defaultPos() {
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1024;
    return vw < MOBILE_BP ? { right: 16, bottom: 24 } : { right: 24, bottom: 24 };
  }

  // Posición segura al abrir: el header siempre queda dentro del viewport.
  // En mobile, además se centra horizontalmente y se pega a top: 8px.
  function safeOpenPos() {
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = size.width, h = size.height;
    if (vw < MOBILE_BP) {
      return {
        right:  clamp(Math.round((vw - w) / 2), 0, Math.max(0, vw - w)),
        bottom: clamp(vh - h - 8, 0, Math.max(0, vh - h)),
      };
    }
    // Desktop: respeta la posición guardada pero garantiza top >= 8px y que no
    // se salga por los lados. top = vh - bottom - h  →  bottom <= vh - h - 8.
    return {
      right:  clamp(pos.right, 0, Math.max(0, vw - w)),
      bottom: clamp(pos.bottom, 0, Math.max(0, vh - h - 8)),
    };
  }

  function openChat() {
    setPos(safeOpenPos());
    setOpen(true);
  }
  function minimizeToBubble() {
    setOpen(false);
    setMaximized(false);
  }
  function closeChat() {
    setOpen(false);
    setMaximized(false);
  }

  // Reposicionar: vuelve al lugar seguro por defecto y borra lo guardado.
  function resetPosition() {
    try { localStorage.removeItem('iris-chat-pos'); } catch {}
    setMaximized(false);
    setPos(defaultPos());
  }

  // ── Estilos del panel: flotante o pantalla completa ──
  const panelStyle: React.CSSProperties = maximized
    ? {
        position: 'fixed', top: 0, left: 0, zIndex: MAX_Z,
        width: '100vw', height: '100dvh', borderRadius: 0,
      }
    : {
        position: 'fixed', right: `${pos.right}px`, bottom: `${pos.bottom}px`, zIndex: 1200,
        width: `${size.width}px`, height: `${size.height}px`,
        borderRadius: '18px', boxShadow: '0 14px 48px rgba(0,0,0,0.35)',
      };

  return (
    <>
      <style>{`
        @keyframes iris-bolt-flash { 0%{color:#AAFF00} 25%{color:#00E5FF} 50%{color:#FF6B00} 75%{color:#CCFF00} 100%{color:#AAFF00} }
        @keyframes iris-bolt-pop { 0%,100%{transform:scale(1)} 50%{transform:scale(1.14)} }
        @keyframes iris-dot { 0%,80%,100%{opacity:.25} 40%{opacity:1} }
        @keyframes iris-wave { 0%,100%{transform:scaleY(.3)} 50%{transform:scaleY(1)} }
        @keyframes iris-rec-pulse { 0%,100%{box-shadow:0 0 0 0 rgba(229,57,53,.55)} 50%{box-shadow:0 0 0 8px rgba(229,57,53,0)} }
        .iris-thinking svg path { animation: iris-bolt-flash .9s linear infinite; fill: currentColor; stroke: currentColor; }
        .iris-thinking { animation: iris-bolt-pop .9s ease-in-out infinite; }
        .iris-wave { display:flex; align-items:center; gap:2px; height:24px; flex:1; }
        .iris-wave span { width:3px; height:100%; background:${ORANGE}; border-radius:2px; transform-origin:center; animation: iris-wave .9s ease-in-out infinite; }
        .iris-rec { animation: iris-rec-pulse 1.1s ease-out infinite; }
      `}</style>

      {/* Burbuja flotante — draggable (mouse + touch); tap para abrir */}
      {!open && (
        <button
          onMouseDown={(e) => { if (e.button !== 0) return; e.preventDefault(); startDrag(e.clientX, e.clientY, { elW: 60, elH: 60, onTap: openChat }); }}
          onTouchStart={(e) => { const t = e.touches[0]; if (!t) return; startDrag(t.clientX, t.clientY, { elW: 60, elH: 60, onTap: openChat, threshold: TOUCH_DRAG_THRESHOLD }); }}
          aria-label="Abrir Iris AI (arrastrá para mover)"
          style={{
            position: 'fixed', right: `${pos.right}px`, bottom: `${pos.bottom}px`, zIndex: 1200,
            width: '60px', height: '60px', borderRadius: '50%',
            background: DARK, border: `2px solid ${ORANGE}`, cursor: 'grab', touchAction: 'none',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 6px 22px rgba(0,0,0,0.4)',
          }}
        >
          <Bolt size={28} />
        </button>
      )}

      {/* Panel */}
      {open && (
        <div style={{ ...panelStyle, background: '#fff', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {/* Handle de resize (oculto en pantalla completa) */}
          {!maximized && (
            <div
              onMouseDown={(e) => { if (e.button !== 0) return; e.preventDefault(); e.stopPropagation(); startResize(e.clientX, e.clientY); }}
              onTouchStart={(e) => { const t = e.touches[0]; if (!t) return; e.stopPropagation(); startResize(t.clientX, t.clientY); }}
              aria-label="Redimensionar"
              style={{ position: 'absolute', top: 0, left: 0, width: '20px', height: '20px', cursor: 'nwse-resize', zIndex: 2, touchAction: 'none' }}
            />
          )}

          {/* Header — draggable (mouse + touch), salvo en pantalla completa */}
          <header
            onMouseDown={(e) => { if (maximized || e.button !== 0) return; e.preventDefault(); startDrag(e.clientX, e.clientY, { elW: size.width, elH: size.height }); }}
            onTouchStart={(e) => { if (maximized) return; const t = e.touches[0]; if (!t) return; startDrag(t.clientX, t.clientY, { elW: size.width, elH: size.height }); }}
            style={{
              background: DARK, padding: '14px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              flexShrink: 0, cursor: maximized ? 'default' : 'move', userSelect: 'none', touchAction: 'none',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span className={thinking ? 'iris-thinking' : ''} style={{ display: 'flex' }}><Bolt size={22} /></span>
              <div>
                <h2 style={{ margin: 0, fontSize: '15px', fontWeight: 900, color: '#fff' }}>Iris AI</h2>
                <p style={{ margin: 0, fontSize: '11px', color: '#aaa' }}>
                  {recording ? 'Grabando…' : thinking ? 'Pensando…' : 'Asistente del CRM IRIS'}
                </p>
              </div>
            </div>
            <div style={{ display: 'flex', gap: '6px' }}>
              <button
                onClick={resetPosition}
                onMouseDown={(e) => e.stopPropagation()}
                onTouchStart={(e) => e.stopPropagation()}
                aria-label="Reposicionar"
                title="Volver a la posición por defecto"
                style={hdrBtn}
              >
                ⊕
              </button>
              <button
                onClick={() => setMaximized((v) => !v)}
                onMouseDown={(e) => e.stopPropagation()}
                onTouchStart={(e) => e.stopPropagation()}
                aria-label={maximized ? 'Restaurar' : 'Maximizar'}
                title={maximized ? 'Restaurar' : 'Pantalla completa'}
                style={hdrBtn}
              >
                {maximized ? '❐' : '⧉'}
              </button>
              <button
                onClick={minimizeToBubble}
                onMouseDown={(e) => e.stopPropagation()}
                onTouchStart={(e) => e.stopPropagation()}
                aria-label="Minimizar a burbuja"
                title="Minimizar a burbuja"
                style={hdrBtn}
              >
                —
              </button>
              <button
                onClick={closeChat}
                onMouseDown={(e) => e.stopPropagation()}
                onTouchStart={(e) => e.stopPropagation()}
                aria-label="Cerrar"
                title="Cerrar"
                style={hdrBtn}
              >
                ✕
              </button>
            </div>
          </header>

          {/* Cuerpo: mensajes + input (siempre visible mientras el panel está abierto) */}
          <>
              {/* Mensajes */}
              <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '16px', background: '#F5F5F5', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {messages.length === 0 && !thinking && (
                  <div style={{ color: '#999', fontSize: '13px', textAlign: 'center', marginTop: '24px', lineHeight: 1.5 }}>
                    Preguntame sobre tu plataforma Iris.<br />
                    Ej: <i>“¿cuántos contactos tengo?”</i>, <i>“top clientes”</i>,<br /><i>“cómo personalizo el dashboard”</i>.
                  </div>
                )}

                {messages.map((m) => {
                  const isUser = m.role === 'user';
                  return (
                    <div key={m.id} style={{ alignSelf: isUser ? 'flex-end' : 'flex-start', maxWidth: '85%' }}>
                      <div
                        style={{
                          background: isUser ? ORANGE : '#ECECEC',
                          color: isUser ? '#fff' : '#111',
                          borderRadius: '14px', padding: '9px 13px', fontSize: '13px', lineHeight: 1.45,
                          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                          boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
                        }}
                      >
                        {m.audioUrl ? (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                              <span aria-hidden="true">🎤</span>
                              <audio controls src={m.audioUrl} style={{ height: '32px', maxWidth: '190px' }} />
                            </div>
                            {m.transcribing ? (
                              <span style={{ display: 'flex', gap: '4px', padding: '2px 0' }}>
                                {[0, 1, 2].map((i) => (
                                  <span key={i} style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'rgba(255,255,255,0.85)', animation: `iris-dot 1.2s ${i * 0.2}s infinite ease-in-out` }} />
                                ))}
                              </span>
                            ) : m.transcript ? (
                              <span style={{ fontStyle: 'italic', fontSize: '12px', color: isUser ? 'rgba(255,255,255,0.85)' : '#777' }}>{m.transcript}</span>
                            ) : null}
                          </div>
                        ) : (
                          m.content
                        )}
                      </div>
                    </div>
                  );
                })}

                {thinking && (
                  <div style={{ alignSelf: 'flex-start', background: '#ECECEC', borderRadius: '14px', padding: '11px 14px', boxShadow: '0 1px 4px rgba(0,0,0,0.06)', display: 'flex', gap: '4px' }}>
                    {[0, 1, 2].map((i) => (
                      <span key={i} style={{ width: '7px', height: '7px', borderRadius: '50%', background: '#888', animation: `iris-dot 1.2s ${i * 0.2}s infinite ease-in-out` }} />
                    ))}
                  </div>
                )}
              </div>

              {/* Input estilo WhatsApp: textarea que crece + botón dinámico */}
              <div style={{ borderTop: '1px solid #eee', padding: '8px 12px', display: 'flex', gap: '8px', alignItems: 'flex-end', flexShrink: 0, background: '#fff' }}>
                {recording ? (
                  <div className="iris-wave" aria-label="Grabando audio" style={{ minHeight: '44px' }}>
                    {Array.from({ length: 18 }).map((_, i) => (
                      <span key={i} style={{ animationDelay: `${i * 0.06}s` }} />
                    ))}
                  </div>
                ) : (
                  <textarea
                    ref={inputRef}
                    rows={1}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendText(); } }}
                    placeholder="Escribí tu pregunta…"
                    disabled={thinking}
                    style={{ flex: 1, minWidth: 0, resize: 'none', minHeight: '44px', maxHeight: '120px', background: '#F5F5F5', border: 'none', borderRadius: '22px', padding: '12px 14px', fontSize: '13px', lineHeight: '20px', color: '#111', outline: 'none', overflowY: 'auto', fontFamily: 'inherit' }}
                  />
                )}

                {/* Botón dinámico: detener (grabando) / enviar (con texto) / micrófono (vacío) */}
                {recording ? (
                  <button
                    onClick={toggleRecording}
                    className="iris-rec"
                    aria-label="Detener grabación"
                    title="Detener"
                    style={{ width: '44px', height: '44px', flexShrink: 0, borderRadius: '50%', border: 'none', cursor: 'pointer', background: '#E53935', color: '#fff', fontSize: '18px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                  >⏹</button>
                ) : input.trim() ? (
                  <button
                    onClick={handleSendText}
                    disabled={thinking}
                    aria-label="Enviar"
                    title="Enviar"
                    style={{ width: '44px', height: '44px', flexShrink: 0, borderRadius: '50%', border: 'none', cursor: thinking ? 'not-allowed' : 'pointer', background: thinking ? '#e6e6e6' : ORANGE, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <path d="M3 11.5 L21 3 L13.5 21 L11 13.5 Z" fill={thinking ? '#999' : '#fff'} stroke={thinking ? '#999' : '#fff'} strokeWidth="1.2" strokeLinejoin="round" />
                    </svg>
                  </button>
                ) : (
                  <button
                    onClick={toggleRecording}
                    disabled={thinking}
                    aria-label="Grabar audio"
                    title="Grabar audio"
                    style={{ width: '44px', height: '44px', flexShrink: 0, borderRadius: '50%', border: 'none', cursor: thinking ? 'not-allowed' : 'pointer', background: '#F0F0F0', color: '#54656f', fontSize: '18px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                  >🎤</button>
                )}
              </div>
          </>
        </div>
      )}
    </>
  );
}

const hdrBtn: React.CSSProperties = {
  background: '#1a1a1a', color: '#fff', border: 'none', borderRadius: '8px',
  width: '30px', height: '30px', fontSize: '14px', cursor: 'pointer',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
};
