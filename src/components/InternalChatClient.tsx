"use client";

import React, { useEffect, useState, useRef, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { formatRelativeTime } from '@/lib/formatRelativeTime';
import { linkify } from '@/lib/linkify';
import { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseBrowser } from '@/lib/supabase-browser';
import { fetchWithTimeout } from '@/lib/fetchWithTimeout';
import { useAuth } from '@/components/AuthProvider';
import { Avatar } from '@/components/ProfileCard';
import { searchEmojisEs } from '@/lib/emoji-es';

// ─────────────────────────────────────────────────────────────────────────────
// Chat interno del equipo (Etapa 1). Sala grupal por tenant (agente + sus
// operadores). NO sale a WhatsApp/Meta. Mismo look & feel que ChatWindow, pero:
//  - chat GRUPAL: mis mensajes a la derecha; los de otros a la izquierda con
//    firma (nombre · rol) + avatar.
//  - sin ticks de entrega, sin plantillas, sin reacciones (no aplica internamente).
// Reusa el formato JSON de media {_type:'image'|'audio', url, caption}.
// ─────────────────────────────────────────────────────────────────────────────

const EmojiPicker = dynamic(() => import('emoji-picker-react'), { ssr: false });

type Message = {
  id?: string;
  room_id?: string;
  author_id?: string | null;
  author_name?: string | null;
  author_role?: string | null;
  author_avatar?: string | null;
  content: string;
  created_at?: string;
  status?: string; // solo local: 'sending' | 'failed'
  traspaso_estado?: string | null; // estado del comprobante (cierres): pendiente|verificado|rechazado
};

const ROLE_LABEL: Record<string, string> = {
  operator: 'operador',
  agent:    'agente',
  admin:    'admin',
};

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

const TA_MAX_H = 120;
function growTextarea(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, TA_MAX_H) + 'px';
}

const actionItem: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: '10px', width: '100%',
  background: 'none', border: 'none', borderRadius: '10px', padding: '10px 12px',
  textAlign: 'left', cursor: 'pointer', fontSize: '14px', color: '#333',
};

const badgeStyle: React.CSSProperties = {
  background: '#FF8C00', color: '#fff', borderRadius: '999px',
  fontSize: '11px', fontWeight: 800, minWidth: '20px', height: '20px',
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '0 6px', flexShrink: 0,
};

type MediaContent = { _type: 'image' | 'audio'; url: string; caption?: string };

function parseMedia(raw: string): MediaContent | null {
  try {
    const p = JSON.parse(raw);
    if ((p?._type === 'image' || p?._type === 'audio') && typeof p.url === 'string') return p;
  } catch {}
  return null;
}

// Mensaje de cierre de turno: lleva el comprobante a verificar embebido.
// content JSON {_type:'traspaso', comprobante_id, text}.
type TraspasoContent = { _type: 'traspaso'; comprobante_id: string | null; text: string };
function parseTraspaso(raw: string): TraspasoContent | null {
  try {
    const p = JSON.parse(raw);
    if (p?._type === 'traspaso' && typeof p.text === 'string') return p;
  } catch {}
  return null;
}

function formatSeconds(s: number) {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// Contraparte para el chat privado 1 a 1 (de /api/internal/members).
type Member = {
  id: string;
  name: string | null;
  role: string;
  avatar_url: string | null;
  dm_room_id: string | null;
  unread?: number;
};

// Reemplaza el mensaje optimista `temp` por el guardado y deduplica por id.
function reconcileSent(list: Message[], temp: Message, saved: Message | null): Message[] {
  if (!saved) {
    return list.map((msg) => (msg === temp ? { ...msg, status: 'failed' } : msg));
  }
  let replacedTemp = false;
  let out = list.map((msg) => {
    if (msg === temp) { replacedTemp = true; return saved; }
    if (saved.id && msg.id === saved.id) return saved;
    return msg;
  });
  if (!replacedTemp && saved.id && !out.some((m) => m.id === saved.id)) {
    out = [...out, saved];
  }
  if (!saved.id) return out;
  const seen = new Set<string>();
  return out.filter((msg) => {
    if (!msg.id) return true;
    if (seen.has(msg.id)) return false;
    seen.add(msg.id);
    return true;
  });
}

export default function InternalChatClient() {
  const { agent } = useAuth();
  const myId = agent?.id ?? null;

  const [roomId, setRoomId] = useState<string | null>(null);
  const [roomName, setRoomName] = useState('Chat interno');
  const [roomError, setRoomError] = useState(false);

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [cooldown, setCooldown] = useState(false);
  const [showActions, setShowActions] = useState(false);
  const [showEmoji, setShowEmoji] = useState(false);
  const [emojiQuery, setEmojiQuery] = useState('');
  const [loadError, setLoadError] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

  // Selector de conversaciones: sala grupal + DMs 1 a 1 con miembros.
  const [groupRoomId,    setGroupRoomId]    = useState<string | null>(null);
  const [members,        setMembers]        = useState<Member[]>([]);
  const [activeMemberId, setActiveMemberId] = useState<string | null>(null); // null = grupo
  const [roomUnreads,    setRoomUnreads]    = useState<Record<string, number>>({});

  // Image state
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);

  // Audio recording state
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [audioPreviewUrl, setAudioPreviewUrl] = useState<string | null>(null);
  // Comprobantes de cierre resueltos en ESTA sesión (override optimista para
  // mostrar el chip correcto al instante). El estado persistido llega igual en
  // cada mensaje (traspaso_estado) vía el GET, así que sobrevive a un reload.
  const [resueltos, setResueltos] = useState<Map<string, 'verificado' | 'rechazado'>>(new Map());
  // Acción de cierre armada para confirmar inline (sin window.confirm bloqueante),
  // id en curso, y errores por comprobante. Todo no bloqueante.
  const [traspasoConfirm, setTraspasoConfirm] = useState<{ id: string; kind: 'verificar' | 'rechazar' } | null>(null);
  const [traspasoBusy, setTraspasoBusy] = useState<string | null>(null);
  const [traspasoErr, setTraspasoErr] = useState<Record<string, string>>({});

  // ── T4 (solo mobile): panel de conversaciones colapsable, recordado por operador ──
  const [panelOpen, setPanelOpen] = useState(false);
  const panelKey = myId ? `iris:internal-panel-open:${myId}` : null;
  useEffect(() => {
    if (!panelKey) return;
    try { setPanelOpen(localStorage.getItem(panelKey) === '1'); } catch {}
  }, [panelKey]);
  const setPanel = useCallback((open: boolean) => {
    setPanelOpen(open);
    if (panelKey) { try { localStorage.setItem(panelKey, open ? '1' : '0'); } catch {} }
  }, [panelKey]);

  const listRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  // Scroll estilo WhatsApp: abrir abajo y seguir el fondo solo si el usuario ya
  // está cerca del fondo (si scrolleó arriba a leer historial, no lo tironeamos).
  const isNearBottomRef = useRef(true);
  const supabaseRef = useRef<SupabaseClient | null>(null);
  const channelRef = useRef<any>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const textInputRef = useRef<HTMLTextAreaElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Scroll helpers (estilo WhatsApp) ─────────────────────────────────────
  const NEAR_BOTTOM_PX = 120;
  function updateNearBottom() {
    const el = listRef.current;
    if (!el) return;
    isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
  }
  function scrollToBottom() {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight; // instantáneo (sin smooth)
  }
  // Refuerzo: re-scroll cuando una imagen termina de cargar (el ResizeObserver
  // ya lo cubre; esto ayuda en navegadores sin RO). Solo si está pegado al fondo.
  function handleMediaLoad() {
    if (isNearBottomRef.current) scrollToBottom();
  }

  // Al cambiar de sala, volver al modo "pegado al fondo" para abrir abajo.
  useEffect(() => { isNearBottomRef.current = true; }, [roomId]);

  // ── Resolver la sala del tenant (get-or-create server-side) ────────────────
  useEffect(() => {
    fetchWithTimeout('/api/internal/room')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.id) { setRoomId(d.id); setGroupRoomId(d.id); if (d.name) setRoomName(d.name); }
        else setRoomError(true);
      })
      .catch(() => setRoomError(true));
  }, []);

  // Miembros (para DMs) + no-leídos por sala (para los badges del selector).
  // Refresca por poll y cuando alguna sala se marca como leída.
  const fetchMembers = useCallback(async () => {
    try {
      const [mRes, uRes] = await Promise.all([
        fetch('/api/internal/members'),
        fetch('/api/internal/unread'),
      ]);
      if (mRes.ok) setMembers(await mRes.json());
      if (uRes.ok) { const u = await uRes.json(); setRoomUnreads(u?.byRoom ?? {}); }
    } catch {}
  }, []);

  useEffect(() => {
    fetchMembers();
    const poll = setInterval(fetchMembers, 10_000);
    window.addEventListener('refresh-internal-unread', fetchMembers);
    return () => { clearInterval(poll); window.removeEventListener('refresh-internal-unread', fetchMembers); };
  }, [fetchMembers]);

  // Abrir la sala grupal.
  const openGroup = useCallback(() => {
    setActiveMemberId(null);
    setMessages([]);
    if (groupRoomId) setRoomId(groupRoomId);
  }, [groupRoomId]);

  // Abrir (o crear) el DM 1 a 1 con un miembro.
  const openDm = useCallback(async (member: Member) => {
    setActiveMemberId(member.id);
    setMessages([]);
    try {
      const res = await fetch(`/api/internal/room?dm=${encodeURIComponent(member.id)}`);
      if (!res.ok) { setRoomError(true); return; }
      const room = await res.json();
      if (room?.id) { setRoomId(room.id); setRoomError(false); }
    } catch { setRoomError(true); }
  }, []);

  const fetchMessages = useCallback(async () => {
    if (!roomId) return;
    try {
      const res = await fetchWithTimeout(`/api/internal/messages?roomId=${roomId}`);
      if (!res.ok) { setLoadError(true); return; }
      setLoadError(false);
      const server: Message[] = (await res.json()).reverse();
      setMessages((prev) => {
        const optimistic = prev.filter((m) => !m.id);
        return [...server, ...optimistic];
      });
    } catch {
      setLoadError(true);
    }
  }, [roomId]);

  // Marca la sala como leída para este miembro + refresca el badge del sidebar.
  const markRead = useCallback(async () => {
    if (!roomId) return;
    try {
      await fetch('/api/internal/mark-read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId }),
      });
      window.dispatchEvent(new Event('refresh-internal-unread'));
    } catch {}
  }, [roomId]);

  // Carga inicial + polling de respaldo + realtime (mismo patrón que ChatWindow).
  useEffect(() => {
    if (!roomId) return;
    fetchMessages();
    markRead();

    const poll = setInterval(() => { fetchMessages(); }, 8000);

    const client = getSupabaseBrowser();
    if (!client) return () => clearInterval(poll);
    supabaseRef.current = client;

    function onInsert(payload: any) {
      const incoming = payload.new as Message;
      setMessages((m) => {
        if (incoming.id && m.some((msg) => msg.id === incoming.id)) return m;
        const idx = m.findIndex((msg) => !msg.id && msg.author_id === incoming.author_id && msg.content === incoming.content);
        if (idx !== -1) {
          const copy = [...m];
          copy[idx] = incoming;
          return copy;
        }
        return [...m, incoming];
      });
      // Si entró un mensaje de otro miembro, lo marcamos leído (estamos en la sala).
      if (incoming.author_id && incoming.author_id !== myId) markRead();
      setTimeout(() => { if (isNearBottomRef.current) scrollToBottom(); }, 50);
    }

    let retry = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const subscribe = () => {
      const channel = client
        .channel(`internal:room:${roomId}`)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'internal_messages', filter: `room_id=eq.${roomId}` }, onInsert)
        .subscribe((status: string) => {
          if (status === 'SUBSCRIBED') { retry = 0; fetchMessages(); return; }
          if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            if (disposed) return;
            const delay = Math.min(30000, 1000 * 2 ** retry);
            retry++;
            if (reconnectTimer) clearTimeout(reconnectTimer);
            reconnectTimer = setTimeout(() => {
              if (disposed) return;
              try { client.removeChannel(channel); } catch (err) { console.warn('[internal chat] removeChannel (reconexión) falló:', err); }
              subscribe();
            }, delay);
          }
        });
      channelRef.current = channel;
    };
    subscribe();

    return () => {
      disposed = true;
      clearInterval(poll);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try { if (channelRef.current) client.removeChannel(channelRef.current); } catch (err) { console.warn('[internal chat] removeChannel (cleanup) falló:', err); }
    };
  }, [roomId, fetchMessages, markRead, myId]);

  // Sigue el fondo de forma robusta: el ResizeObserver dispara cuando el
  // contenido cambia de alto (mensajes nuevos e imágenes que cargan/expanden).
  // Si el usuario está pegado al fondo, baja al fondo real; si scrolleó arriba,
  // no lo toca. Cubre imágenes cacheadas donde el onLoad puede no dispararse.
  useEffect(() => {
    const scroller = listRef.current;
    const content  = contentRef.current;
    if (!scroller || !content || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (isNearBottomRef.current) scroller.scrollTop = scroller.scrollHeight;
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, []);

  useEffect(() => { growTextarea(textInputRef.current); }, [input]);

  // Cierra paneles (emoji / acciones) al clickear afuera.
  useEffect(() => {
    if (!showEmoji && !showActions) return;
    function handleClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setShowEmoji(false);
        setShowActions(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showEmoji, showActions]);

  useEffect(() => {
    return () => {
      if (imagePreview) URL.revokeObjectURL(imagePreview);
      if (audioPreviewUrl) URL.revokeObjectURL(audioPreviewUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      const pos = start + emoji.length;
      el.setSelectionRange(pos, pos);
    });
  }

  // ── Image ──────────────────────────────────────────────────────────────
  function acceptImageFile(file: File) {
    clearAudio();
    setImageFile(file);
    setImagePreview((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(file);
    });
  }
  function handleImageFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    if (!file) return;
    acceptImageFile(file);
    e.target.value = '';
  }
  function handlePasteImage(e: React.ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const it of items) {
      if (it.kind === 'file' && it.type.startsWith('image/')) {
        const file = it.getAsFile();
        if (file) { e.preventDefault(); acceptImageFile(file); }
        return;
      }
    }
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

  function clearAudio() {
    setAudioBlob(null);
    if (audioPreviewUrl) { URL.revokeObjectURL(audioPreviewUrl); setAudioPreviewUrl(null); }
    setRecordingSeconds(0);
  }

  // ── Send ───────────────────────────────────────────────────────────────
  async function handleSend(e?: React.FormEvent) {
    e?.preventDefault();
    if (loading || cooldown || !roomId) return;
    if (audioBlob) return handleSendAudio();
    if (imageFile) return handleSendImage();
    return handleSendText();
  }

  // Ejecuta la acción de cierre (verificar/rechazar) ya confirmada inline. Endpoint
  // compartido (acepta agent y operador); el backend deja pasar solo a quien
  // corresponde. Sin window.confirm/alert: estado no bloqueante por comprobante.
  async function ejecutarTraspaso(comprobanteId: string | null, kind: 'verificar' | 'rechazar') {
    setTraspasoConfirm(null);
    if (!comprobanteId) {
      if (comprobanteId !== null) setTraspasoErr((e) => ({ ...e, [comprobanteId]: 'Mensaje sin comprobante asociado.' }));
      return;
    }
    setTraspasoBusy(comprobanteId);
    setTraspasoErr((e) => { const n = { ...e }; delete n[comprobanteId]; return n; });
    try {
      const res = await fetch(`/api/caja/traspaso?accion=${kind}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comprobanteId }),
      });
      if (!res.ok) {
        const msg = (await res.text().catch(() => '')) || (kind === 'verificar' ? 'No se pudo verificar' : 'No se pudo rechazar');
        setTraspasoErr((e) => ({ ...e, [comprobanteId]: msg }));
        return;
      }
      setResueltos((s) => new Map(s).set(comprobanteId, kind === 'verificar' ? 'verificado' : 'rechazado'));
    } catch {
      setTraspasoErr((e) => ({ ...e, [comprobanteId]: 'Error de red. Reintentá.' }));
    } finally {
      setTraspasoBusy(null);
    }
  }

  async function handleSendText() {
    const content = input.trim();
    if (!content) return;
    setInput('');
    await sendText(content);
  }

  async function sendText(content: string) {
    if (!roomId) return;
    setSendError(null);
    setLoading(true);
    setCooldown(true);
    const temp: Message = { content, status: 'sending', author_id: myId, author_name: agent?.name, author_role: agent?.role, author_avatar: agent?.avatar_url };
    setMessages((m) => [...m, temp]);
    try {
      const res = await fetchWithTimeout('/api/internal/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId, content }),
      });
      const saved: Message | null = res.ok ? await res.json() : null;
      if (!saved) setSendError('No se pudo enviar el mensaje. Reintentá.');
      setMessages((m) => reconcileSent(m, temp, saved));
    } catch {
      setSendError('No se pudo enviar el mensaje. Revisá tu conexión y reintentá.');
      setMessages((m) => m.map((msg) => msg === temp ? { ...msg, status: 'failed' } : msg));
    }
    setLoading(false);
    setTimeout(() => setCooldown(false), 1500);
  }

  async function retrySend(failed: Message) {
    if (loading || cooldown) return;
    if (parseMedia(failed.content)) return; // media requiere re-adjuntar
    setMessages((m) => m.filter((x) => x !== failed));
    await sendText(failed.content);
  }

  async function handleSendImage() {
    if (!imageFile || !roomId) return;
    const caption = input.trim();
    const preview = imagePreview;
    setImageFile(null); setImagePreview(null); setInput('');
    setLoading(true); setCooldown(true);
    const tempContent = JSON.stringify({ _type: 'image', url: preview ?? '', caption });
    const temp: Message = { content: tempContent, status: 'sending', author_id: myId, author_name: agent?.name, author_role: agent?.role, author_avatar: agent?.avatar_url };
    setMessages((m) => [...m, temp]);
    const form = new FormData();
    form.append('file', imageFile);
    form.append('roomId', roomId);
    form.append('caption', caption);
    setSendError(null);
    try {
      const res = await fetchWithTimeout('/api/internal/messages/image', { method: 'POST', body: form }, 30000);
      const saved = res.ok ? await res.json() : null;
      if (!saved) setSendError('No se pudo enviar la imagen. Volvé a adjuntarla y reintentá.');
      setMessages((m) => reconcileSent(m, temp, saved));
    } catch {
      setSendError('No se pudo enviar la imagen. Revisá tu conexión y reintentá.');
      setMessages((m) => m.map((msg) => msg === temp ? { ...msg, status: 'failed' } : msg));
    }
    if (preview) URL.revokeObjectURL(preview);
    setLoading(false);
    setTimeout(() => setCooldown(false), 1500);
  }

  async function handleSendAudio() {
    if (!audioBlob || !roomId) return;
    const preview = audioPreviewUrl;
    const blob = audioBlob;
    setAudioBlob(null); setAudioPreviewUrl(null);
    setLoading(true); setCooldown(true);
    const tempContent = JSON.stringify({ _type: 'audio', url: preview ?? '' });
    const temp: Message = { content: tempContent, status: 'sending', author_id: myId, author_name: agent?.name, author_role: agent?.role, author_avatar: agent?.avatar_url };
    setMessages((m) => [...m, temp]);
    const form = new FormData();
    const ext = blob.type.includes('ogg') ? 'ogg' : blob.type.includes('mp4') ? 'm4a' : blob.type.includes('mpeg') ? 'mp3' : 'webm';
    form.append('file', blob, `audio.${ext}`);
    form.append('roomId', roomId);
    setSendError(null);
    try {
      const res = await fetchWithTimeout('/api/internal/messages/audio', { method: 'POST', body: form }, 30000);
      const saved = res.ok ? await res.json() : null;
      if (!saved) setSendError('No se pudo enviar el audio. Volvé a grabarlo y reintentá.');
      setMessages((m) => reconcileSent(m, temp, saved));
    } catch {
      setSendError('No se pudo enviar el audio. Revisá tu conexión y reintentá.');
      setMessages((m) => m.map((msg) => msg === temp ? { ...msg, status: 'failed' } : msg));
    }
    if (preview) URL.revokeObjectURL(preview);
    setLoading(false);
    setTimeout(() => setCooldown(false), 1500);
  }

  const canSend = !loading && !cooldown && !isRecording && !!roomId && (!!input.trim() || !!imageFile || !!audioBlob);

  if (roomError) {
    return (
      <div style={{ background: '#fff', borderRadius: '20px', padding: '32px', textAlign: 'center', color: '#999' }}>
        No se pudo abrir el chat interno. Recargá la página.
      </div>
    );
  }

  const activeMember = members.find((m) => m.id === activeMemberId) ?? null;
  const isGroup = activeMemberId === null;
  // Badge del grupo: sus no-leídos salvo cuando es la sala activa (ya leída).
  const groupUnread = isGroup ? 0 : (groupRoomId ? (roomUnreads[groupRoomId] ?? 0) : 0);
  function memberUnread(m: Member): number {
    if (m.id === activeMemberId) return 0; // activa → leída
    return m.dm_room_id ? (roomUnreads[m.dm_room_id] ?? m.unread ?? 0) : (m.unread ?? 0);
  }

  const activeTargetName = isGroup ? roomName : (activeMember?.name || 'Mensaje directo');

  return (
    <div className="internal-chat-wrap" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>

      {/* T4 (solo mobile): indicador del destino activo; tocarlo abre/cierra el panel. */}
      <button
        type="button"
        className="internal-mobile-toggle"
        onClick={() => setPanel(!panelOpen)}
        aria-expanded={panelOpen}
      >
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {isGroup ? '👥 ' : ''}{activeTargetName}
        </span>
        <span aria-hidden style={{ flexShrink: 0, transition: 'transform .15s', transform: panelOpen ? 'rotate(90deg)' : 'none' }}>▸</span>
      </button>

      <div className={`internal-chat${panelOpen ? '' : ' panel-collapsed'}`} style={{ display: 'flex', gap: '16px', alignItems: 'stretch', flex: 1, minHeight: 0 }}>

      {/* T4 (solo mobile): fondo oscuro; tocarlo cierra el dropdown. */}
      {panelOpen && <div className="internal-panel-backdrop" onClick={() => setPanel(false)} aria-hidden />}

      {/* ── Columna izquierda: selector de conversaciones (grupo + DMs) ── */}
      <aside className="internal-rooms" style={{ gap: '10px', overflowY: 'auto' }}>
        {/* Sala grupal */}
        <button
          type="button"
          onClick={() => { openGroup(); setPanel(false); }}
          style={{
            textAlign: 'left', cursor: 'pointer', border: 'none', width: '100%',
            background: '#FFFFFF', borderRadius: '16px', padding: '16px 18px',
            boxShadow: isGroup ? '0 1px 8px rgba(0,0,0,0.06), inset 3px 0 0 #C8FF00' : '0 1px 8px rgba(0,0,0,0.06)',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px',
          }}
        >
          <div style={{ minWidth: 0 }}>
            <p style={{ fontSize: '15px', fontWeight: 800, color: '#000', margin: 0, display: 'flex', alignItems: 'center', gap: '7px' }}>
              <span style={{ fontSize: '18px' }}>👥</span> {roomName}
            </p>
            <p style={{ fontSize: '12px', color: '#999', margin: '2px 0 0 0' }}>Equipo del tenant · interno</p>
          </div>
          {groupUnread > 0 && (
            <span style={badgeStyle}>{groupUnread > 99 ? '99+' : groupUnread}</span>
          )}
        </button>

        {/* DMs 1 a 1 */}
        {members.length > 0 && (
          <p style={{ fontSize: '11px', fontWeight: 700, color: '#aaa', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '6px 4px 0 4px' }}>
            Mensajes directos
          </p>
        )}
        {members.map((m) => {
          const active = m.id === activeMemberId;
          const n = memberUnread(m);
          return (
            <button
              key={m.id}
              type="button"
              onClick={() => { openDm(m); setPanel(false); }}
              style={{
                textAlign: 'left', cursor: 'pointer', border: 'none', width: '100%',
                background: '#FFFFFF', borderRadius: '14px', padding: '12px 14px',
                boxShadow: active ? '0 1px 8px rgba(0,0,0,0.06), inset 3px 0 0 #C8FF00' : '0 1px 8px rgba(0,0,0,0.06)',
                display: 'flex', alignItems: 'center', gap: '10px',
              }}
            >
              <Avatar url={m.avatar_url} name={m.name ?? ''} size={34} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <p style={{ fontSize: '14px', fontWeight: 700, color: '#000', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {m.name || 'Sin nombre'}
                </p>
                <p style={{ fontSize: '11px', color: '#999', margin: '1px 0 0 0' }}>{ROLE_LABEL[m.role] ?? m.role}</p>
              </div>
              {n > 0 && <span style={badgeStyle}>{n > 99 ? '99+' : n}</span>}
            </button>
          );
        })}
      </aside>

      {/* ── Columna derecha: chat (flex column de alto completo) ── */}
      <div style={{ flex: 1, minWidth: 0, minHeight: 0, background: '#FFFFFF', borderRadius: '20px', padding: '20px', boxShadow: '0 2px 16px rgba(0,0,0,0.07)', display: 'flex', flexDirection: 'column' }}>

        {/* Header de la conversación activa (grupo o DM). */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', paddingBottom: '14px', marginBottom: '14px', borderBottom: '1px solid #f0f0f0' }}>
          {isGroup ? (
            <>
              <span style={{ fontSize: '20px' }}>👥</span>
              <div style={{ minWidth: 0 }}>
                <p style={{ fontSize: '15px', fontWeight: 800, color: '#000', margin: 0 }}>{roomName}</p>
                <p style={{ fontSize: '11px', color: '#999', margin: 0 }}>Sala del equipo · interno</p>
              </div>
            </>
          ) : (
            <>
              <Avatar url={activeMember?.avatar_url ?? null} name={activeMember?.name ?? ''} size={34} />
              <div style={{ minWidth: 0 }}>
                <p style={{ fontSize: '15px', fontWeight: 800, color: '#000', margin: 0 }}>{activeMember?.name || 'Mensaje directo'}</p>
                <p style={{ fontSize: '11px', color: '#999', margin: 0 }}>Chat privado · {ROLE_LABEL[activeMember?.role ?? ''] ?? activeMember?.role ?? ''}</p>
              </div>
            </>
          )}
        </div>

        {/* Message list (scroller externo) + contenido observado por el RO.
            flex:1 + minHeight:0 → único que scrollea; la caja queda fija abajo. */}
        <div
          ref={listRef}
          onScroll={updateNearBottom}
          style={{ flex: 1, minHeight: 0, overflowY: 'auto', paddingRight: '4px', marginBottom: '16px' }}
        >
        <div ref={contentRef} style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {loadError && messages.length === 0 && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px', background: '#FDECEA', color: '#B71C1C', borderRadius: '12px', padding: '10px 14px', fontSize: '13px' }}>
              <span>⚠ No se pudieron cargar los mensajes.</span>
              <button type="button" onClick={() => fetchMessages()} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#B71C1C', fontWeight: 700, textDecoration: 'underline', fontSize: '13px', padding: 0 }}>Reintentar</button>
            </div>
          )}
          {!loadError && messages.length === 0 && (
            <div style={{ textAlign: 'center', padding: '40px 0', color: '#bbb', fontSize: '14px' }}>
              No hay mensajes todavía. Escribí el primero 👋
            </div>
          )}
          {messages.map((m, i) => {
            const isMine = !!m.author_id && m.author_id === myId;
            const media = parseMedia(m.content);
            const traspaso = parseTraspaso(m.content);
            const signature = m.author_name
              ? `${m.author_name}${m.author_role ? ` · ${ROLE_LABEL[m.author_role] ?? m.author_role}` : ''}`
              : '';
            return (
              <div
                key={m.id ?? i}
                style={{
                  position: 'relative',
                  maxWidth: '78%',
                  alignSelf: isMine ? 'flex-end' : 'flex-start',
                  background: isMine ? '#C8FF00' : '#F0F0F0',
                  color: '#000',
                  borderRadius: isMine ? '16px 4px 16px 16px' : '4px 16px 16px 16px',
                  padding: '10px 14px',
                  wordBreak: 'break-word',
                }}
              >
                {/* Firma del autor (siempre que se conozca): nombre · rol + avatar.
                    En los míos la omito (ya sé que soy yo) salvo el avatar. */}
                {!isMine && signature && (
                  <span style={{ display: 'flex', alignItems: 'center', gap: '5px', margin: '0 0 4px 0' }}>
                    <Avatar url={m.author_avatar} name={m.author_name ?? ''} size={16} />
                    <span style={{ fontSize: '11px', fontWeight: 700, opacity: 0.65 }}>{signature}</span>
                  </span>
                )}

                {media?._type === 'image' ? (
                  <div>
                    <img
                      src={media.url}
                      alt={media.caption || 'imagen'}
                      style={{ maxWidth: '280px', maxHeight: '320px', width: '100%', objectFit: 'contain', borderRadius: '10px', display: 'block', cursor: 'pointer', background: '#00000010' }}
                      onLoad={handleMediaLoad}
                      onClick={() => setLightboxUrl(media.url)}
                    />
                    {media.caption && <p style={{ margin: '6px 0 0 0', fontSize: '14px', lineHeight: 1.5 }}>{media.caption}</p>}
                  </div>
                ) : media?._type === 'audio' ? (
                  <audio controls src={media.url} style={{ width: '100%', minWidth: '200px', marginTop: '2px' }} />
                ) : (
                  <p style={{ margin: 0, fontSize: '14px', lineHeight: 1.5 }}>{linkify(traspaso ? traspaso.text : m.content)}</p>
                )}

                {/* Cierre de turno: si ya está resuelto (estado persistido en
                    traspaso_estado, u override local), mostramos un chip ✓/✗ —
                    para todos, incluido el que cerró. Si sigue pendiente y NO es
                    propio, los botones inline (confirmación no bloqueante). Si es
                    propio y pendiente, nada (espera al receptor). */}
                {traspaso && (() => {
                  const cid = traspaso.comprobante_id ?? '';
                  const estadoServer = m.traspaso_estado;
                  const estadoFinal = resueltos.get(cid)
                    ?? (estadoServer === 'verificado' || estadoServer === 'rechazado' ? estadoServer : null);

                  if (estadoFinal) {
                    const ok = estadoFinal === 'verificado';
                    return (
                      <div style={{ marginTop: '8px' }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '12px', fontWeight: 800, color: ok ? '#1a7a3a' : '#c0392b', background: ok ? '#e8fff0' : '#fdecea', borderRadius: '999px', padding: '4px 10px' }}>
                          {ok ? '✓ Verificado' : '✗ Rechazado'}
                        </span>
                      </div>
                    );
                  }

                  if (isMine) return null; // el que cerró espera la confirmación del receptor

                  const busy = traspasoBusy === cid;
                  const armado = traspasoConfirm?.id === cid ? traspasoConfirm.kind : null;
                  const err = traspasoErr[cid];
                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '8px' }}>
                      {armado ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                          <span style={{ fontSize: '12px', fontWeight: 700 }}>
                            {armado === 'verificar' ? '¿Confirmar recepción?' : '¿Rechazar el cierre?'}
                          </span>
                          <button type="button" disabled={busy}
                            onClick={() => ejecutarTraspaso(traspaso.comprobante_id, armado)}
                            style={{ background: armado === 'verificar' ? '#1a7a3a' : '#c0392b', color: '#fff', fontWeight: 800, fontSize: '12px', border: 'none', borderRadius: '8px', padding: '7px 12px', cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1 }}>
                            {busy ? '…' : 'Sí'}
                          </button>
                          <button type="button" disabled={busy}
                            onClick={() => setTraspasoConfirm(null)}
                            style={{ background: '#e0e0e0', color: '#333', fontWeight: 800, fontSize: '12px', border: 'none', borderRadius: '8px', padding: '7px 12px', cursor: busy ? 'default' : 'pointer' }}>
                            No
                          </button>
                        </div>
                      ) : (
                        <div style={{ display: 'flex', gap: '8px' }}>
                          <button type="button"
                            onClick={() => setTraspasoConfirm({ id: cid, kind: 'verificar' })}
                            style={{ background: '#1a7a3a', color: '#fff', fontWeight: 800, fontSize: '12px', border: 'none', borderRadius: '8px', padding: '7px 12px', cursor: 'pointer' }}>
                            ✓ Verificar
                          </button>
                          <button type="button"
                            onClick={() => setTraspasoConfirm({ id: cid, kind: 'rechazar' })}
                            style={{ background: '#c0392b', color: '#fff', fontWeight: 800, fontSize: '12px', border: 'none', borderRadius: '8px', padding: '7px 12px', cursor: 'pointer' }}>
                            ✗ Rechazar
                          </button>
                        </div>
                      )}
                      {err && <span style={{ fontSize: '11px', fontWeight: 700, color: '#c0392b' }}>{err}</span>}
                    </div>
                  );
                })()}

                {/* Hora + estado local (enviando / fallido con reintento) */}
                <p style={{ margin: '6px 0 0 0', fontSize: '11px', opacity: 0.5, display: 'flex', alignItems: 'center', gap: '5px', justifyContent: isMine ? 'flex-end' : 'flex-start' }}
                   title={m.created_at ? new Date(m.created_at).toLocaleString('es-AR') : undefined}>
                  {m.created_at && <span>{formatRelativeTime(m.created_at)}</span>}
                  {m.status === 'sending' && <span title="Enviando" style={{ fontSize: '11px', opacity: 0.6 }}>🕓</span>}
                  {m.status === 'failed' && (
                    <>
                      <span title="No se pudo enviar" style={{ color: '#E53935', fontSize: '11px', fontWeight: 700 }}>⚠ No enviado</span>
                      {!media && (
                        <button type="button" onClick={() => retrySend(m)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#E53935', fontSize: '11px', fontWeight: 700, textDecoration: 'underline', padding: 0 }}>
                          Reintentar
                        </button>
                      )}
                    </>
                  )}
                </p>
              </div>
            );
          })}
        </div>
        </div>

        {/* Input area — fija abajo, no se encoge */}
        <div style={{ position: 'relative', flexShrink: 0 }} ref={panelRef}>

          {/* Emoji picker */}
          {showEmoji && (
            <div style={{ position: 'absolute', bottom: 'calc(100% + 8px)', left: 0, zIndex: 50, background: '#fff', borderRadius: '12px', boxShadow: '0 6px 24px rgba(0,0,0,0.18)', padding: '8px', width: '320px' }}>
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
                      <button key={i} type="button" onClick={() => { insertEmoji(e); setEmojiQuery(''); }} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '22px', padding: '2px', lineHeight: 1 }}>{e}</button>
                    ))
                  )}
                </div>
              )}
              <EmojiPicker
                onEmojiClick={(data) => insertEmoji(data.emoji)}
                searchPlaceHolder="Buscar emoji..."
                categories={EMOJI_CATEGORIES}
                lazyLoadEmojis
              />
            </div>
          )}

          {/* Menú "+" */}
          {showActions && (
            <div style={{ position: 'absolute', bottom: 'calc(100% + 8px)', left: 0, background: '#fff', borderRadius: '14px', boxShadow: '0 4px 24px rgba(0,0,0,0.16)', padding: '6px', zIndex: 50, display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '200px' }}>
              <button type="button" onClick={() => { setShowActions(false); setShowEmoji(true); }} style={actionItem} onMouseEnter={(e) => (e.currentTarget.style.background = '#F5F5F5')} onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}>
                <span style={{ fontSize: '18px' }}>😊</span> Emoji
              </button>
              <button type="button" onClick={() => { setShowActions(false); clearAudio(); imageInputRef.current?.click(); }} style={actionItem} onMouseEnter={(e) => (e.currentTarget.style.background = '#F5F5F5')} onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}>
                <span style={{ fontSize: '18px' }}>📎</span> Adjuntar imagen
              </button>
            </div>
          )}

          {/* Image preview */}
          {imagePreview && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', background: '#F5F5F5', borderRadius: '14px', padding: '10px 14px', marginBottom: '10px' }}>
              <img src={imagePreview} alt="preview" style={{ width: '56px', height: '56px', objectFit: 'cover', borderRadius: '8px', flexShrink: 0 }} />
              <p style={{ fontSize: '13px', color: '#555', margin: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{imageFile?.name || 'Imagen pegada'}</p>
              <button type="button" onClick={clearImage} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#999', fontSize: '20px', lineHeight: 1, padding: '4px' }}>×</button>
            </div>
          )}

          <input ref={imageInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleImageFileChange} />

          {sendError && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', background: '#FDECEA', color: '#B71C1C', borderRadius: '12px', padding: '10px 14px', marginBottom: '10px', fontSize: '13px', flexWrap: 'wrap' }}>
              <span style={{ flex: 1, minWidth: '160px' }}>⚠ {sendError}</span>
              <button type="button" onClick={() => setSendError(null)} aria-label="Cerrar" style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#B71C1C', fontSize: '18px', lineHeight: 1, padding: '2px' }}>×</button>
            </div>
          )}

          <form onSubmit={handleSend} style={{ display: 'flex', alignItems: 'flex-end', gap: '6px', background: '#fff', borderTop: '1px solid #eee', padding: '8px 12px' }}>
            {isRecording ? (
              <>
                <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: '10px', height: '44px', padding: '0 10px', color: '#E53935', fontWeight: 700, fontSize: '14px' }}>
                  <span style={{ display: 'inline-block', width: '10px', height: '10px', borderRadius: '50%', background: '#E53935', animation: 'pulse 1s infinite', flexShrink: 0 }} />
                  Grabando… {formatSeconds(recordingSeconds)}
                </div>
                <button type="button" onClick={stopRecording} title="Detener grabación" aria-label="Detener grabación" className="wa-send-btn" style={{ background: '#E53935' }}>⏹</button>
              </>
            ) : audioBlob ? (
              <>
                <button type="button" onClick={clearAudio} title="Descartar audio" aria-label="Descartar audio" className="wa-icon-btn" style={{ color: '#E53935', fontSize: '18px' }}>🗑️</button>
                <audio controls src={audioPreviewUrl ?? undefined} style={{ flex: 1, minWidth: 0, height: '40px' }} />
                <button type="submit" disabled={!canSend} title="Enviar audio" aria-label="Enviar audio" className="wa-send-btn" style={{ background: canSend ? '#C8FF00' : '#e0e0e0', color: '#000' }}>
                  {loading ? '…' : cooldown ? '✓' : (
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 11.5 L21 3 L13.5 21 L11 13.5 Z" fill="#000" stroke="#000" strokeWidth="1.2" strokeLinejoin="round" /></svg>
                  )}
                </button>
              </>
            ) : (
              <>
                <button type="button" onClick={() => { setShowEmoji(false); setShowActions((v) => !v); }} title="Más acciones" aria-label="Más acciones" className="wa-icon-btn" style={{ background: showActions ? '#E8FFB0' : 'transparent', fontSize: '26px' }}>+</button>
                <textarea
                  ref={textInputRef}
                  rows={1}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
                  onPaste={handlePasteImage}
                  placeholder={imageFile ? 'Agregar descripción (opcional)...' : 'Escribí un mensaje al equipo... (podés pegar una imagen)'}
                  style={{ flex: 1, minWidth: 0, resize: 'none', minHeight: '44px', maxHeight: `${TA_MAX_H}px`, background: '#F5F5F5', border: 'none', borderRadius: '22px', padding: '11px 16px', fontSize: '14px', lineHeight: '20px', color: '#1a1a1a', outline: 'none', overflowY: 'auto', fontFamily: 'inherit' }}
                />
                {canSend ? (
                  <button type="submit" title="Enviar" aria-label="Enviar" className="wa-send-btn" style={{ background: '#C8FF00', color: '#000' }}>
                    {loading ? '…' : cooldown ? '✓' : (
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 11.5 L21 3 L13.5 21 L11 13.5 Z" fill="#000" stroke="#000" strokeWidth="1.2" strokeLinejoin="round" /></svg>
                    )}
                  </button>
                ) : (
                  <button type="button" onClick={startRecording} title="Grabar audio" aria-label="Grabar audio" className="wa-icon-btn">🎤</button>
                )}
              </>
            )}
          </form>
        </div>
      </div>
      </div>

      {/* Lightbox */}
      {lightboxUrl && (
        <div onClick={() => setLightboxUrl(null)} style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.85)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px', cursor: 'zoom-out' }}>
          <img src={lightboxUrl} alt="imagen completa" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '95vw', maxHeight: '90vh', objectFit: 'contain', borderRadius: '8px' }} />
          <button onClick={() => setLightboxUrl(null)} aria-label="Cerrar" style={{ position: 'fixed', top: '16px', right: '20px', background: 'rgba(255,255,255,0.15)', color: '#fff', border: 'none', borderRadius: '50%', width: '40px', height: '40px', fontSize: '22px', cursor: 'pointer', lineHeight: 1 }}>×</button>
        </div>
      )}

      <style>{`
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
        .wa-icon-btn { width: 40px; height: 40px; min-width: 40px; flex-shrink: 0; padding: 0; border: none; border-radius: 50%; background: transparent; color: #54656f; font-size: 20px; line-height: 1; cursor: pointer; display: flex; align-items: center; justify-content: center; }
        .wa-icon-btn:hover { background: #f0f2f5; }
        .wa-icon-btn:disabled { opacity: .4; cursor: not-allowed; }
        .wa-send-btn { width: 44px; height: 44px; min-width: 44px; flex-shrink: 0; padding: 0; border: none; border-radius: 50%; cursor: pointer; color: #fff; font-size: 18px; display: flex; align-items: center; justify-content: center; }
        /* Ancho y display del panel movidos del inline al CSS para que mobile pueda sobreescribirlos (el inline le gana al stylesheet). En desktop queda 280px en columna, idéntico a antes. */
        .internal-rooms { width: 280px; flex-shrink: 0; display: flex; flex-direction: column; }
        .internal-mobile-toggle { display: none; }
        .internal-panel-backdrop { display: none; }
        @media (max-width: 768px) {
          /* T4: en mobile el panel se DESPLIEGA como dropdown que tapa el chat; el chat queda al 100% de ancho (así el input no se aplasta). */
          .internal-chat { position: relative; }
          .internal-rooms {
            position: absolute; top: 0; left: 0; right: 0; width: auto; max-width: none;
            max-height: 70vh; overflow-y: auto; z-index: 20;
            background: #F5F5F5; padding: 12px;
            border-radius: 0 0 16px 16px; box-shadow: 0 10px 28px rgba(0,0,0,0.22);
          }
          .internal-chat.panel-collapsed .internal-rooms { display: none; }
          .internal-panel-backdrop { display: block; position: absolute; inset: 0; z-index: 15; background: rgba(0,0,0,0.35); }
          .internal-mobile-toggle {
            display: flex; align-items: center; justify-content: space-between; gap: 8px;
            width: 100%; margin-bottom: 12px; padding: 10px 14px;
            background: #FFFFFF; border: none; border-radius: 12px;
            box-shadow: 0 1px 8px rgba(0,0,0,0.06);
            font-size: 14px; font-weight: 700; color: #000; cursor: pointer;
          }
          .wa-icon-btn { width: 44px; height: 44px; min-width: 44px; }
        }
      `}</style>
    </div>
  );
}
