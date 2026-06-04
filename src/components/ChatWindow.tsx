"use client";

import React, { useEffect, useState, useRef, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { formatRelativeTime } from '@/lib/formatRelativeTime';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { useAuth } from '@/components/AuthProvider';
import { searchEmojisEs } from '@/lib/emoji-es';

const EmojiPicker = dynamic(() => import('emoji-picker-react'), { ssr: false });

type Message = {
  id?: string;
  contact_id?: string;
  role: string;
  content: string;
  created_at?: string;
  status?: string;
  agent_name?: string | null;
  whatsapp_message_id?: string | null;
  reaction?: string | null;
};

// Categorías del emoji picker en español (la librería no tiene locale 'es').
const EMOJI_CATEGORIES = [
  { category: 'suggested',      name: 'Recientes' },
  { category: 'smileys_people', name: 'Caritas y personas' },
  { category: 'animals_nature', name: 'Animales y naturaleza' },
  { category: 'food_drink',     name: 'Comida y bebida' },
  { category: 'travel_places',  name: 'Viajes y lugares' },
  { category: 'activities',     name: 'Actividades' },
  { category: 'objects',        name: 'Objetos' },
  { category: 'symbols',        name: 'Símbolos' },
  { category: 'flags',          name: 'Banderas' },
] as any;

// Opciones de reacción rápida (WhatsApp Reactions API).
const REACTION_EMOJIS = ['👍', '✅', '👀', '❤️'];

// Clasifica el contenido de un mensaje para renderizarlo. Cubre los mensajes
// viejos de imagen guardados como texto "image"/"document" o como URL pelada.
function classifyBody(content: string): { kind: 'text' | 'image' | 'image-missing' | 'doc-missing' | 'audio-missing' | 'file'; url?: string } {
  const c = (content ?? '').trim();
  const isUrl = /^https?:\/\//i.test(c);
  if (isUrl && /\.(jpe?g|png|webp|gif)(\?|$)/i.test(c)) return { kind: 'image', url: c };
  if (isUrl) return { kind: 'file', url: c };
  if (c === 'image')                    return { kind: 'image-missing' };
  if (c === 'document')                 return { kind: 'doc-missing' };
  if (c === 'audio' || c === 'voice')   return { kind: 'audio-missing' };
  return { kind: 'text' };
}

// Ticks de estado para mensajes salientes (estilo WhatsApp).
function Ticks({ status }: { status?: string }) {
  if (status === 'failed')  return <span title="No enviado"  style={{ color: '#E53935', fontSize: '11px' }}>⚠</span>;
  if (status === 'sending') return <span title="Enviando"    style={{ fontSize: '11px', opacity: 0.6 }}>🕓</span>;
  if (status === 'read')      return <span title="Leído"      style={{ color: '#34B7F1', fontSize: '11px', fontWeight: 700 }}>✓✓</span>;
  if (status === 'delivered') return <span title="Entregado"  style={{ color: '#888',    fontSize: '11px', fontWeight: 700 }}>✓✓</span>;
  // 'sent' o sin status (mensajes viejos) → un tilde gris.
  return <span title="Enviado" style={{ color: '#888', fontSize: '11px' }}>✓</span>;
}

type QuickReply = { id: string; title: string; content: string };
type MediaContent = { _type: 'image' | 'audio'; url: string; caption?: string };


function parseMedia(raw: string): MediaContent | null {
  try {
    const p = JSON.parse(raw);
    if ((p?._type === 'image' || p?._type === 'audio') && typeof p.url === 'string') return p;
  } catch {}
  return null;
}

function formatSeconds(s: number) {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// Reemplaza el mensaje optimista `temp` por el guardado y deduplica por id.
// Evita el doble mensaje cuando el evento realtime de Supabase ya appendeó la
// misma fila antes de que volviera la respuesta del POST (race condition).
function reconcileSent(list: Message[], temp: Message, saved: Message | null): Message[] {
  const replaced = list.map((msg) => (msg === temp ? (saved ?? { ...msg, status: 'failed' }) : msg));
  if (!saved?.id) return replaced;
  const seen = new Set<string>();
  return replaced.filter((msg) => {
    if (!msg.id) return true;            // optimistas sin id se conservan
    if (seen.has(msg.id)) return false;  // descarta duplicados por id
    seen.add(msg.id);
    return true;
  });
}

export default function ChatWindow({ contactId }: { contactId: string }) {
  const { agent } = useAuth();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [cooldown, setCooldown] = useState(false);
  const [quickReplies, setQuickReplies] = useState<QuickReply[]>([]);
  const [showQR, setShowQR] = useState(false);

  // Image state
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);

  // Audio recording state
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [audioPreviewUrl, setAudioPreviewUrl] = useState<string | null>(null);
  const [showEmoji, setShowEmoji] = useState(false);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [reactBarFor, setReactBarFor] = useState<string | null>(null); // id del mensaje con barra de reacciones abierta
  const [emojiQuery, setEmojiQuery] = useState('');
  const longPressRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const listRef = useRef<HTMLDivElement | null>(null);
  const supabaseRef = useRef<SupabaseClient | null>(null);
  const channelRef = useRef<any>(null);
  const qrPanelRef = useRef<HTMLDivElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const audioInputRef = useRef<HTMLInputElement | null>(null);
  const textInputRef = useRef<HTMLInputElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  useEffect(() => {
    if (!showQR && !showEmoji) return;
    function handleClick(e: MouseEvent) {
      if (qrPanelRef.current && !qrPanelRef.current.contains(e.target as Node)) {
        setShowQR(false);
        setShowEmoji(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showQR, showEmoji]);

  function insertEmoji(emoji: string) {
    setShowEmoji(false);
    const el = textInputRef.current;
    if (!el) { setInput((v) => v + emoji); return; }
    const start = el.selectionStart ?? el.value.length;
    const end   = el.selectionEnd   ?? el.value.length;
    const next  = el.value.slice(0, start) + emoji + el.value.slice(end);
    setInput(next);
    requestAnimationFrame(() => {
      el.focus();
      // Avanzar el cursor en code units UTF-16 (emoji.length), NO en code points.
      // Usar [...emoji].length deja el cursor en medio del par surrogate y el
      // próximo insert parte el emoji → surrogate suelto → se guarda como "�".
      const pos = start + emoji.length;
      el.setSelectionRange(pos, pos);
    });
  }

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
          event: 'INSERT', schema: 'public', table: 'messages',
          filter: `contact_id=eq.${contactId}`,
        }, (payload: any) => {
          setMessages((m) => {
            if (payload.new.id && m.some((msg) => msg.id === payload.new.id)) return m;
            return [...m, payload.new];
          });
          setTimeout(() => { if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight; }, 50);
        })
        // UPDATE: refleja en vivo cambios de status (ticks) y reacciones.
        .on('postgres_changes', {
          event: 'UPDATE', schema: 'public', table: 'messages',
          filter: `contact_id=eq.${contactId}`,
        }, (payload: any) => {
          setMessages((m) => m.map((msg) => (msg.id === payload.new.id ? { ...msg, ...payload.new } : msg)));
        })
        .subscribe();
      channelRef.current = channel;
    } catch {}
    return () => { try { if (channelRef.current) supabaseRef.current?.removeChannel(channelRef.current); } catch {} };
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

  // Cleanup object URLs on unmount
  useEffect(() => {
    return () => {
      if (imagePreview) URL.revokeObjectURL(imagePreview);
      if (audioPreviewUrl) URL.revokeObjectURL(audioPreviewUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Image ──────────────────────────────────────────────────────────────
  function handleImageFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    if (!file) return;
    clearAudio();
    setImageFile(file);
    setImagePreview(URL.createObjectURL(file));
    e.target.value = '';
  }

  function clearImage() {
    setImageFile(null);
    if (imagePreview) { URL.revokeObjectURL(imagePreview); setImagePreview(null); }
  }

  // ── Audio recording ────────────────────────────────────────────────────
  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunksRef.current = [];

      // Prefer OGG (WhatsApp-compatible), fall back to whatever browser supports
      const mimeType = MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')
        ? 'audio/ogg;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : '';

      const mr = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      mediaRecorderRef.current = mr;

      mr.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
      mr.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(audioChunksRef.current, { type: mr.mimeType });
        setAudioBlob(blob);
        setAudioPreviewUrl(URL.createObjectURL(blob));
      };

      mr.start(100);
      setIsRecording(true);
      setRecordingSeconds(0);
      recordingTimerRef.current = setInterval(() => setRecordingSeconds((s) => s + 1), 1000);
    } catch {
      alert('No se pudo acceder al micrófono. Verificá los permisos del navegador.');
    }
  }, []);

  const stopRecording = useCallback(() => {
    if (recordingTimerRef.current) { clearInterval(recordingTimerRef.current); recordingTimerRef.current = null; }
    mediaRecorderRef.current?.stop();
    setIsRecording(false);
  }, []);

  function handleAudioFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    if (!file) return;
    clearImage();
    setAudioBlob(file);
    setAudioPreviewUrl(URL.createObjectURL(file));
    e.target.value = '';
  }

  function clearAudio() {
    setAudioBlob(null);
    if (audioPreviewUrl) { URL.revokeObjectURL(audioPreviewUrl); setAudioPreviewUrl(null); }
    setRecordingSeconds(0);
  }

  // ── Send ───────────────────────────────────────────────────────────────
  async function handleSend(e?: React.FormEvent) {
    e?.preventDefault();
    if (loading || cooldown) return;
    if (audioBlob) return handleSendAudio();
    if (imageFile) return handleSendImage();
    return handleSendText();
  }

  async function handleSendText() {
    const content = input.trim();
    if (!content) return;
    setInput('');
    setLoading(true);
    setCooldown(true);
    const temp: Message = { role: 'human', content, status: 'sending', agent_name: agent?.name };
    setMessages((m) => [...m, temp]);
    try {
      const res = await fetch('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactId, content }),
      });
      const saved = res.ok ? await res.json() : null;
      setMessages((m) => reconcileSent(m, temp, saved));
    } catch {
      setMessages((m) => m.map((msg) => msg === temp ? { ...msg, status: 'failed' } : msg));
    }
    setLoading(false);
    setTimeout(() => setCooldown(false), 2000);
  }

  async function handleSendImage() {
    if (!imageFile) return;
    const caption = input.trim();
    const preview = imagePreview;
    setImageFile(null); setImagePreview(null); setInput('');
    setLoading(true); setCooldown(true);
    const tempContent = JSON.stringify({ _type: 'image', url: preview ?? '', caption });
    const temp: Message = { role: 'human', content: tempContent, status: 'sending', agent_name: agent?.name };
    setMessages((m) => [...m, temp]);
    const form = new FormData();
    form.append('file', imageFile);
    form.append('contactId', contactId);
    form.append('caption', caption);
    try {
      const res = await fetch('/api/messages/image', { method: 'POST', body: form });
      const saved = res.ok ? await res.json() : null;
      setMessages((m) => reconcileSent(m, temp, saved));
    } catch {
      setMessages((m) => m.map((msg) => msg === temp ? { ...msg, status: 'failed' } : msg));
    }
    if (preview) URL.revokeObjectURL(preview);
    setLoading(false);
    setTimeout(() => setCooldown(false), 2000);
  }

  async function handleSendAudio() {
    if (!audioBlob) return;
    const preview = audioPreviewUrl;
    const blob = audioBlob;
    setAudioBlob(null); setAudioPreviewUrl(null);
    setLoading(true); setCooldown(true);
    const tempContent = JSON.stringify({ _type: 'audio', url: preview ?? '' });
    const temp: Message = { role: 'human', content: tempContent, status: 'sending', agent_name: agent?.name };
    setMessages((m) => [...m, temp]);
    const form = new FormData();
    const ext = blob.type.includes('ogg') ? 'ogg' : blob.type.includes('mp4') ? 'm4a' : blob.type.includes('mpeg') ? 'mp3' : 'webm';
    form.append('file', blob, `audio.${ext}`);
    form.append('contactId', contactId);
    try {
      const res = await fetch('/api/messages/audio', { method: 'POST', body: form });
      const saved = (res.ok || res.status === 207) ? await res.json() : null;
      setMessages((m) => reconcileSent(m, temp, saved));
    } catch {
      setMessages((m) => m.map((msg) => msg === temp ? { ...msg, status: 'failed' } : msg));
    }
    if (preview) URL.revokeObjectURL(preview);
    setLoading(false);
    setTimeout(() => setCooldown(false), 2000);
  }

  // ── Reacciones a mensajes del cliente (WhatsApp Reactions API) ───────────
  async function sendReaction(msg: Message, emoji: string) {
    if (!msg.id) return;
    const next = msg.reaction === emoji ? '' : emoji; // re-clic en la misma → quita
    setReactBarFor(null);
    setMessages((m) => m.map((x) => (x.id === msg.id ? { ...x, reaction: next || null } : x)));
    try {
      await fetch('/api/messages/react', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ messageId: msg.id, emoji: next }),
      });
    } catch { /* el estado optimista ya refleja el cambio */ }
  }

  function startLongPress(id: string) {
    if (longPressRef.current) clearTimeout(longPressRef.current);
    longPressRef.current = setTimeout(() => setReactBarFor(id), 450);
  }
  function cancelLongPress() {
    if (longPressRef.current) { clearTimeout(longPressRef.current); longPressRef.current = null; }
  }

  const canSend = !loading && !cooldown && !isRecording && (!!input.trim() || !!imageFile || !!audioBlob);

  return (
    <div style={{ background: '#FFFFFF', borderRadius: '20px', padding: '20px', boxShadow: '0 2px 16px rgba(0,0,0,0.07)' }}>

      {/* Message list */}
      <div
        ref={listRef}
        style={{ display: 'flex', flexDirection: 'column', gap: '10px', maxHeight: '60vh', overflowY: 'auto', paddingRight: '4px', marginBottom: '16px' }}
      >
        {messages
          // Ocultar mensajes de reacción guardados como texto "reaction" (viejos,
          // de antes de manejar las reacciones como badge). No son burbujas.
          .filter((m) => m.content !== 'reaction' && (m as any).type !== 'reaction')
          .map((m, i) => {
          const isBot   = m.role === 'assistant';
          const isHuman = m.role === 'human';
          // Mensajes humanos: nombre real del agente; fallback "Operador" para los viejos sin atribución
          const roleLabel = isBot ? 'Iris 🤖' : isHuman ? (m.agent_name || 'Operador') : 'Cliente';
          const media = parseMedia(m.content);
          // Solo se puede reaccionar a mensajes del cliente (tienen wamid).
          const reactable = m.role === 'user' && !!m.id && !!m.whatsapp_message_id;
          return (
            <div
              key={m.id ?? i}
              className="chat-msg"
              onMouseEnter={() => { if (reactable) setReactBarFor(m.id!); }}
              onMouseLeave={() => setReactBarFor((cur) => (cur === m.id ? null : cur))}
              onTouchStart={() => { if (reactable) startLongPress(m.id!); }}
              onTouchEnd={cancelLongPress}
              onTouchMove={cancelLongPress}
              style={{
                position: 'relative',
                maxWidth: '78%',
                // Cliente (user) a la derecha; bot y operador (human) a la izquierda.
                alignSelf: isBot || isHuman ? 'flex-start' : 'flex-end',
                background: isBot ? '#F0F0F0' : isHuman ? '#C8FF00' : '#1a1a1a',
                color: isBot ? '#333' : isHuman ? '#000' : '#fff',
                borderRadius: isBot || isHuman ? '4px 16px 16px 16px' : '16px 4px 16px 16px',
                padding: '10px 14px',
                wordBreak: 'break-word',
              }}
            >
              <p style={{ fontSize: '11px', fontWeight: 600, opacity: 0.6, margin: '0 0 4px 0' }}>
                {roleLabel}
              </p>

              {media?._type === 'image' ? (
                <div>
                  <img
                    src={media.url}
                    alt={media.caption || 'imagen'}
                    style={{
                      maxWidth: '280px', maxHeight: '320px', width: '100%',
                      objectFit: 'contain', borderRadius: '10px',
                      display: 'block', cursor: 'pointer', background: '#00000010',
                    }}
                    onClick={() => setLightboxUrl(media.url)}
                  />
                  {media.caption && <p style={{ margin: '6px 0 0 0', fontSize: '14px', lineHeight: 1.5 }}>{media.caption}</p>}
                </div>
              ) : media?._type === 'audio' ? (
                <audio
                  controls
                  src={media.url}
                  style={{ width: '100%', minWidth: '200px', marginTop: '2px' }}
                />
              ) : (() => {
                const b = classifyBody(m.content);
                if (b.kind === 'image' && b.url) {
                  const url = b.url;
                  return (
                    <img
                      src={url}
                      alt="imagen"
                      style={{ maxWidth: '280px', maxHeight: '320px', width: '100%', objectFit: 'contain', borderRadius: '10px', display: 'block', cursor: 'pointer', background: '#00000010' }}
                      onClick={() => setLightboxUrl(url)}
                    />
                  );
                }
                if (b.kind === 'file' && b.url) {
                  return <a href={b.url} target="_blank" rel="noreferrer" style={{ fontSize: '14px', textDecoration: 'underline', color: 'inherit' }}>📎 Ver archivo</a>;
                }
                if (b.kind === 'image-missing') return <span style={{ fontSize: '14px', opacity: 0.85 }}>🖼️ Imagen</span>;
                if (b.kind === 'doc-missing')   return <span style={{ fontSize: '14px', opacity: 0.85 }}>📄 Documento</span>;
                if (b.kind === 'audio-missing') return <span style={{ fontSize: '14px', opacity: 0.85 }}>🎤 Audio</span>;
                return <p style={{ margin: 0, fontSize: '14px', lineHeight: 1.5 }}>{m.content}</p>;
              })()}

              {/* Hora + ticks (ticks solo en salientes) */}
              <p style={{ margin: '6px 0 0 0', fontSize: '11px', opacity: 0.5, display: 'flex', alignItems: 'center', gap: '5px', justifyContent: isBot || isHuman ? 'flex-start' : 'flex-end' }}
                 title={m.created_at ? new Date(m.created_at).toLocaleString('es-AR') : undefined}>
                {m.created_at && <span>{formatRelativeTime(m.created_at)}</span>}
                {(isBot || isHuman) && <Ticks status={m.status} />}
              </p>

              {/* Reacción aplicada */}
              {m.reaction && (
                <span style={{
                  position: 'absolute', bottom: '-9px', right: '8px',
                  background: '#fff', borderRadius: '999px', padding: '1px 5px',
                  fontSize: '13px', lineHeight: 1, boxShadow: '0 1px 4px rgba(0,0,0,0.22)',
                }}>
                  {m.reaction}
                </span>
              )}

              {/* Barra de reacciones (hover desktop / long-press mobile) */}
              {reactable && reactBarFor === m.id && (
                <div
                  onMouseEnter={() => setReactBarFor(m.id!)}
                  onMouseLeave={() => setReactBarFor(null)}
                  style={{
                  position: 'absolute', top: '-40px', right: 0,
                  display: 'flex', gap: '2px',
                  background: '#fff', borderRadius: '999px', padding: '4px 6px',
                  boxShadow: '0 3px 12px rgba(0,0,0,0.18)', zIndex: 5,
                }}>
                  {REACTION_EMOJIS.map((e) => (
                    <button
                      key={e}
                      type="button"
                      onClick={() => sendReaction(m, e)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '18px', lineHeight: 1, padding: '2px 4px' }}
                    >
                      {e}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Input area */}
      <div style={{ position: 'relative' }} ref={qrPanelRef}>

        {/* Quick-reply panel */}
        {showQR && (
          <div style={{ position: 'absolute', bottom: 'calc(100% + 8px)', left: 0, right: 0, background: '#fff', borderRadius: '16px', boxShadow: '0 4px 24px rgba(0,0,0,0.13)', padding: '8px', zIndex: 50, maxHeight: '240px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {quickReplies.length === 0 ? (
              <p style={{ fontSize: '13px', color: '#999', padding: '10px 12px', margin: 0 }}>No hay respuestas rápidas. Creá una en Configuración.</p>
            ) : quickReplies.map((qr) => (
              <button
                key={qr.id}
                type="button"
                onClick={() => { setInput(qr.content); setShowQR(false); }}
                style={{ background: 'none', border: 'none', borderRadius: '10px', padding: '10px 14px', textAlign: 'left', cursor: 'pointer' }}
                onMouseEnter={(e) => (e.currentTarget.style.background = '#F5F5F5')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
              >
                <p style={{ fontSize: '11px', fontWeight: 700, color: '#C8FF00', margin: '0 0 2px 0', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{qr.title}</p>
                <p style={{ fontSize: '13px', color: '#333', margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{qr.content}</p>
              </button>
            ))}
          </div>
        )}

        {/* Emoji picker panel */}
        {showEmoji && (
          <div style={{ position: 'absolute', bottom: 'calc(100% + 8px)', left: 0, zIndex: 50, background: '#fff', borderRadius: '12px', boxShadow: '0 6px 24px rgba(0,0,0,0.18)', padding: '8px', width: '320px' }}>
            {/* Búsqueda en español (el picker solo busca en inglés) */}
            <input
              value={emojiQuery}
              onChange={(e) => setEmojiQuery(e.target.value)}
              placeholder="Buscar en español: fuego, suerte, plata…"
              style={{ width: '100%', padding: '8px 12px', border: '1px solid #eee', borderRadius: '8px', fontSize: '13px', outline: 'none', marginBottom: '8px', boxSizing: 'border-box' }}
            />
            {emojiQuery.trim() && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px', marginBottom: '8px', maxHeight: '96px', overflowY: 'auto' }}>
                {searchEmojisEs(emojiQuery).length === 0 ? (
                  <span style={{ fontSize: '12px', color: '#999', padding: '4px' }}>Sin resultados en español. Usá el listado de abajo.</span>
                ) : (
                  searchEmojisEs(emojiQuery).map((e, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => { insertEmoji(e); setEmojiQuery(''); }}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '22px', padding: '2px', lineHeight: 1 }}
                    >
                      {e}
                    </button>
                  ))
                )}
              </div>
            )}
            <EmojiPicker
              onEmojiClick={(data) => insertEmoji(data.emoji)}
              searchPlaceHolder="Buscar emoji..."
              searchPlaceholder="Buscar emoji..."
              categories={EMOJI_CATEGORIES}
              previewConfig={{ defaultCaption: 'Elegí un emoji…', showPreview: true, defaultEmoji: '1f60a' }}
              lazyLoadEmojis
            />
          </div>
        )}

        {/* Image preview */}
        {imagePreview && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', background: '#F5F5F5', borderRadius: '14px', padding: '10px 14px', marginBottom: '10px' }}>
            <img src={imagePreview} alt="preview" style={{ width: '56px', height: '56px', objectFit: 'cover', borderRadius: '8px', flexShrink: 0 }} />
            <p style={{ fontSize: '13px', color: '#555', margin: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{imageFile?.name}</p>
            <button type="button" onClick={clearImage} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#999', fontSize: '20px', lineHeight: 1, padding: '4px' }}>×</button>
          </div>
        )}

        {/* Audio preview */}
        {audioPreviewUrl && !isRecording && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', background: '#F5F5F5', borderRadius: '14px', padding: '10px 14px', marginBottom: '10px' }}>
            <audio controls src={audioPreviewUrl} style={{ flex: 1, height: '36px' }} />
            <button type="button" onClick={clearAudio} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#999', fontSize: '20px', lineHeight: 1, padding: '4px' }}>×</button>
          </div>
        )}

        {/* Hidden file inputs */}
        <input ref={imageInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleImageFileChange} />
        <input ref={audioInputRef} type="file" accept="audio/*" style={{ display: 'none' }} onChange={handleAudioFileChange} />

        <form onSubmit={handleSend} className="chat-input-row" style={{ display: 'flex', gap: '10px' }}>

          {/* Quick-replies toggle */}
          <button
            type="button"
            onClick={() => { setShowEmoji(false); setShowQR((v) => !v); }}
            title="Respuestas rápidas"
            disabled={isRecording}
            style={{ background: showQR ? '#C8FF00' : '#F5F5F5', border: 'none', borderRadius: '12px', padding: '12px 14px', fontSize: '16px', cursor: isRecording ? 'not-allowed' : 'pointer', flexShrink: 0, lineHeight: 1, opacity: isRecording ? 0.4 : 1 }}
          >⚡</button>

          {/* Emoji picker toggle */}
          <button
            type="button"
            onClick={() => { setShowQR(false); setShowEmoji((v) => !v); }}
            title="Emojis"
            disabled={isRecording}
            style={{ background: showEmoji ? '#C8FF00' : '#F5F5F5', border: 'none', borderRadius: '12px', padding: '12px 14px', fontSize: '16px', cursor: isRecording ? 'not-allowed' : 'pointer', flexShrink: 0, lineHeight: 1, opacity: isRecording ? 0.4 : 1 }}
          >😊</button>

          {/* Image attach */}
          <button
            type="button"
            onClick={() => { clearAudio(); imageInputRef.current?.click(); }}
            title="Adjuntar imagen"
            disabled={isRecording}
            style={{ background: imageFile ? '#C8FF00' : '#F5F5F5', border: 'none', borderRadius: '12px', padding: '12px 14px', fontSize: '16px', cursor: isRecording ? 'not-allowed' : 'pointer', flexShrink: 0, lineHeight: 1, opacity: isRecording ? 0.4 : 1 }}
          >📎</button>

          {/* Audio record / upload */}
          {isRecording ? (
            <button
              type="button"
              onClick={stopRecording}
              title="Detener grabación"
              style={{ background: '#ff4444', border: 'none', borderRadius: '12px', padding: '12px 14px', fontSize: '13px', fontWeight: 700, cursor: 'pointer', flexShrink: 0, color: '#fff', display: 'flex', alignItems: 'center', gap: '6px' }}
            >
              <span style={{ display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', background: '#fff', animation: 'pulse 1s infinite' }} />
              {formatSeconds(recordingSeconds)}
            </button>
          ) : (
            <button
              type="button"
              onClick={audioBlob ? () => { clearImage(); audioInputRef.current?.click(); } : startRecording}
              title={audioBlob ? 'Subir audio' : 'Grabar audio'}
              style={{ background: audioBlob ? '#C8FF00' : '#F5F5F5', border: 'none', borderRadius: '12px', padding: '12px 14px', fontSize: '16px', cursor: 'pointer', flexShrink: 0, lineHeight: 1 }}
            >🎙️</button>
          )}

          {/* Text input (hidden while recording) */}
          {!isRecording && !audioBlob && (
            <input
              ref={textInputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={imageFile ? 'Agregar descripción (opcional)...' : 'Escribí un mensaje...'}
              style={{ flex: 1, minWidth: 0, background: '#F5F5F5', border: 'none', borderRadius: '12px', padding: '12px 16px', fontSize: '14px', color: '#1a1a1a', outline: 'none' }}
            />
          )}
          {(isRecording || audioBlob) && <div style={{ flex: 1 }} />}

          {/* Send */}
          <button
            type="submit"
            disabled={!canSend}
            style={{
              background: canSend ? '#C8FF00' : '#e0e0e0',
              color: '#000',
              fontWeight: 700,
              fontSize: '14px',
              border: 'none',
              borderRadius: '12px',
              padding: '12px 20px',
              cursor: canSend ? 'pointer' : 'not-allowed',
              opacity: canSend ? 1 : 0.6,
              boxShadow: canSend ? '0 4px 12px rgba(200,255,0,0.3)' : 'none',
            }}
          >
            {loading ? '...' : cooldown ? '✓' : 'Enviar'}
          </button>
        </form>
      </div>

      {/* Lightbox simple para ver la imagen en tamaño completo */}
      {lightboxUrl && (
        <div
          onClick={() => setLightboxUrl(null)}
          style={{
            position: 'fixed', inset: 0, zIndex: 1000,
            background: 'rgba(0,0,0,0.85)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '20px', cursor: 'zoom-out',
          }}
        >
          <img
            src={lightboxUrl}
            alt="imagen completa"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: '95vw', maxHeight: '90vh', objectFit: 'contain', borderRadius: '8px' }}
          />
          <button
            onClick={() => setLightboxUrl(null)}
            aria-label="Cerrar"
            style={{
              position: 'fixed', top: '16px', right: '20px',
              background: 'rgba(255,255,255,0.15)', color: '#fff', border: 'none',
              borderRadius: '50%', width: '40px', height: '40px', fontSize: '22px',
              cursor: 'pointer', lineHeight: 1,
            }}
          >×</button>
        </div>
      )}

      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }`}</style>
    </div>
  );
}
