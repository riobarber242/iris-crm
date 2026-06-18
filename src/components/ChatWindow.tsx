"use client";

import React, { useEffect, useState, useRef, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { formatRelativeTime } from '@/lib/formatRelativeTime';
import { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseBrowser } from '@/lib/supabase-browser';
import { fetchWithTimeout } from '@/lib/fetchWithTimeout';
import { useAuth } from '@/components/AuthProvider';
import { Avatar } from '@/components/ProfileCard';
import { searchEmojisEs } from '@/lib/emoji-es';
import { TEMPLATES, previewTemplate } from '@/lib/meta/templates';

// Detecta el error de "ventana de 24h" de Meta (texto o código 131047) para
// ofrecer el envío por plantilla.
function is24hWindowError(msg: string | null): boolean {
  return !!msg && /24\s*hours?|24\s*hs|131047|re-?engagement/i.test(msg);
}

const EmojiPicker = dynamic(() => import('emoji-picker-react'), { ssr: false });

type Message = {
  id?: string;
  contact_id?: string;
  role: string;
  content: string;
  created_at?: string;
  status?: string;
  agent_name?: string | null;
  agent_role?: string | null;
  agent_avatar?: string | null;
  whatsapp_message_id?: string | null;
  reaction?: string | null;
};

// Etiqueta de rol para la firma de mensajes manuales (ej: "jessica · operador").
const ROLE_LABEL: Record<string, string> = {
  operator: 'operador',
  agent:    'agente',
  admin:    'admin',
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

// Textarea estilo WhatsApp: crece de 1 línea hasta ~5, luego scroll interno.
const TA_MAX_H = 120; // ~5 líneas
function growTextarea(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, TA_MAX_H) + 'px';
}

// Fila del menú "+" (acciones colapsadas).
const actionItem: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: '10px', width: '100%',
  background: 'none', border: 'none', borderRadius: '10px', padding: '10px 12px',
  textAlign: 'left', cursor: 'pointer', fontSize: '14px', color: '#333',
};

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
  if (status === 'failed')  return <span title="Meta rechazó el envío — el mensaje NO llegó" style={{ color: '#E53935', fontSize: '11px', fontWeight: 700 }}>⚠ No entregado</span>;
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
  // Falló el POST: marcamos el optimista como fallido (sin tocar nada más).
  if (!saved) {
    return list.map((msg) => (msg === temp ? { ...msg, status: 'failed' } : msg));
  }

  // Reemplazamos el optimista por el guardado. Si el evento realtime ya
  // appendeó la misma fila (por id), le aplicamos el estado final acá también
  // para que el dedup posterior deje una sola burbuja.
  let replacedTemp = false;
  let out = list.map((msg) => {
    if (msg === temp) { replacedTemp = true; return saved; }
    if (saved.id && msg.id === saved.id) return saved;
    return msg;
  });

  // Si el realtime ya había reemplazado al temp, garantizamos que saved esté.
  if (!replacedTemp && saved.id && !out.some((m) => m.id === saved.id)) {
    out = [...out, saved];
  }

  if (!saved.id) return out;
  const seen = new Set<string>();
  return out.filter((msg) => {
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
  const [showActions, setShowActions] = useState(false); // menú "+" (rápidas/emoji/adjuntar)
  const [loadError, setLoadError] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [showTemplates,   setShowTemplates]   = useState(false);
  const [templateSending, setTemplateSending] = useState(false);

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
  // "Enviar a verificar": ids de mensajes que ya generaron un comprobante
  // (para no duplicar) y el id en vuelo mientras se crea.
  const [verifSentIds, setVerifSentIds] = useState<Set<string>>(new Set());
  const [verifSendingId, setVerifSendingId] = useState<string | null>(null);
  const longPressRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reactBarLeaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const listRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  // Scroll estilo WhatsApp: abrir abajo y seguir el fondo solo si el usuario ya
  // está cerca del fondo (si scrolleó arriba a leer historial, no lo tironeamos).
  const isNearBottomRef = useRef(true);
  const supabaseRef = useRef<SupabaseClient | null>(null);
  const channelRef = useRef<any>(null);
  const qrPanelRef = useRef<HTMLDivElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const audioInputRef = useRef<HTMLInputElement | null>(null);
  const textInputRef = useRef<HTMLTextAreaElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Scroll helpers ───────────────────────────────────────────────────────
  const NEAR_BOTTOM_PX = 120; // margen para considerar "está mirando lo último"
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

  // Al cambiar de conversación (el componente no se remonta: solo cambia la
  // prop) volvemos al modo "pegado al fondo" para abrir abajo el chat nuevo.
  useEffect(() => { isNearBottomRef.current = true; }, [contactId]);

  // Trae los mensajes del server y los fusiona conservando los mensajes
  // optimistas locales (los que todavía no tienen id en la DB: enviando/fallidos).
  // Así el polling de respaldo nunca borra una burbuja en vuelo.
  const fetchMessages = useCallback(async () => {
    try {
      const res = await fetchWithTimeout(`/api/messages?contactId=${contactId}`);
      if (!res.ok) { setLoadError(true); return; }
      setLoadError(false);
      const server: Message[] = (await res.json()).reverse();
      setMessages((prev) => {
        const optimistic = prev.filter((m) => !m.id); // sin id = aún no guardado
        return [...server, ...optimistic];
      });
    } catch {
      setLoadError(true);
    }
  }, [contactId]);

  // Carga qué mensajes de este contacto ya fueron enviados a verificar, para
  // marcar el botón. Usa source_message_id de los comprobantes del contacto.
  const fetchVerifSent = useCallback(async () => {
    try {
      const res = await fetchWithTimeout(`/api/comprobantes?contactId=${contactId}`);
      if (!res.ok) return;
      const rows = await res.json();
      if (!Array.isArray(rows)) return;
      const ids = rows.map((c: any) => c.source_message_id).filter(Boolean) as string[];
      setVerifSentIds(new Set(ids));
    } catch {}
  }, [contactId]);

  // "Enviar a verificar": crea un comprobante (carga si es del cliente, pago si
  // lo mandamos nosotros) a partir del mensaje. Optimista + reconciliación.
  async function sendToVerify(msg: Message) {
    if (!msg.id || verifSendingId || verifSentIds.has(msg.id)) return;
    setVerifSendingId(msg.id);
    // Marca optimista (se confirma al volver; se revierte si falla).
    setVerifSentIds((s) => new Set(s).add(msg.id!));
    try {
      const res = await fetchWithTimeout('/api/comprobantes', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ messageId: msg.id }),
      });
      if (!res.ok) throw new Error(await res.text());
      await fetchVerifSent();
    } catch {
      // Revertir la marca optimista si no se pudo crear.
      setVerifSentIds((s) => { const n = new Set(s); n.delete(msg.id!); return n; });
      setSendError('No se pudo enviar a verificar. Probá de nuevo.');
    } finally {
      setVerifSendingId(null);
    }
  }

  useEffect(() => {
    fetch('/api/quick-replies')
      .then((r) => r.json())
      .then((data) => { if (Array.isArray(data)) setQuickReplies(data); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!showQR && !showEmoji && !showActions) return;
    function handleClick(e: MouseEvent) {
      if (qrPanelRef.current && !qrPanelRef.current.contains(e.target as Node)) {
        setShowQR(false);
        setShowEmoji(false);
        setShowActions(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showQR, showEmoji, showActions]);

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

  // Auto-crecimiento del textarea: ante cualquier cambio de `input` (tipeo,
  // emoji, respuesta rápida o reset al enviar) reajusta la altura.
  useEffect(() => { growTextarea(textInputRef.current); }, [input]);

  useEffect(() => {
    fetchMessages();
    fetchVerifSent();

    // A1 — Polling de respaldo: aunque Realtime ande, refrescamos cada 8s para
    // no perder mensajes si el websocket se cae en silencio (tab en background,
    // token vencido, blip de red). El merge conserva las burbujas optimistas.
    const poll = setInterval(() => { fetchMessages(); fetchVerifSent(); }, 8000);

    const client = getSupabaseBrowser();
    if (!client) return () => clearInterval(poll);
    supabaseRef.current = client;

    function onInsert(payload: any) {
      setMessages((m) => {
        const incoming = payload.new;
        // Ya está por id → no duplicar.
        if (incoming.id && m.some((msg) => msg.id === incoming.id)) return m;
        // Coincide con un optimista propio (sin id, mismo rol y contenido) →
        // reemplazarlo en lugar de agregar otra burbuja (evita el flash doble).
        const idx = m.findIndex((msg) => !msg.id && msg.role === incoming.role && msg.content === incoming.content);
        if (idx !== -1) {
          const copy = [...m];
          copy[idx] = incoming;
          return copy;
        }
        return [...m, incoming];
      });
      setTimeout(() => { if (isNearBottomRef.current) scrollToBottom(); }, 50);
    }
    function onUpdate(payload: any) {
      setMessages((m) => m.map((msg) => (msg.id === payload.new.id ? { ...msg, ...payload.new } : msg)));
    }

    // A2 — Reconexión automática con backoff exponencial ante errores del canal.
    let retry = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const subscribe = () => {
      const channel = client
        .channel(`messages:contact:${contactId}`)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `contact_id=eq.${contactId}` }, onInsert)
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages', filter: `contact_id=eq.${contactId}` }, onUpdate)
        .subscribe((status: string) => {
          if (status === 'SUBSCRIBED') {
            retry = 0;
            fetchMessages(); // re-sincronizar lo que se haya perdido mientras estaba caído
            return;
          }
          if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            if (disposed) return;
            const delay = Math.min(30000, 1000 * 2 ** retry);
            retry++;
            if (reconnectTimer) clearTimeout(reconnectTimer);
            reconnectTimer = setTimeout(() => {
              if (disposed) return;
              try { client.removeChannel(channel); } catch (err) { console.warn('[chat realtime] removeChannel (reconexión) falló:', err); }
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
      try { if (channelRef.current) client.removeChannel(channelRef.current); } catch (err) { console.warn('[chat realtime] removeChannel (cleanup) falló:', err); }
    };
  }, [contactId, fetchMessages, fetchVerifSent]);

  // Sigue el fondo de forma robusta: el ResizeObserver dispara cada vez que el
  // contenido cambia de alto (mensajes nuevos, e imágenes/comprobantes que
  // cargan y expanden el alto). Si el usuario está pegado al fondo, baja al
  // fondo real; si scrolleó arriba, no lo toca. Cubre el caso de imágenes
  // cacheadas, donde el onLoad puede no dispararse.
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
  // Acepta una imagen (del file-input o del portapapeles) y la deja lista para
  // enviar con vista previa. Revoca el preview anterior para no filtrar URLs.
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

  // Pegar (Ctrl+V) una imagen del portapapeles en el chat: muestra la vista
  // previa (NO envía); el usuario confirma con el botón enviar. Reusa el mismo
  // flujo que adjuntar archivo. Si el portapapeles trae texto, no interfiere.
  function handlePasteImage(e: React.ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const it of items) {
      if (it.kind === 'file' && it.type.startsWith('image/')) {
        const file = it.getAsFile();
        if (file) {
          e.preventDefault();
          acceptImageFile(file);
        }
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
    await sendText(content);
  }

  // Núcleo del envío de texto, reutilizable por el botón y por "Reintentar".
  async function sendText(content: string) {
    setSendError(null);
    setLoading(true);
    setCooldown(true);
    const temp: Message = { role: 'human', content, status: 'sending', agent_name: agent?.name, agent_role: agent?.role, agent_avatar: agent?.avatar_url };
    setMessages((m) => [...m, temp]);
    try {
      const res = await fetchWithTimeout('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactId, content }),
      });
      let saved: Message | null = null;
      if (res.ok) {
        saved = await res.json();
        // El backend incluye `error` (motivo real de WhatsApp) si el envío falló.
        if (!saved || saved.status === 'failed') {
          setSendError((saved as any)?.error || 'No se pudo enviar el mensaje. Reintentá.');
        }
      } else {
        // Error de la API (403/404/500…): mostrar el cuerpo real si lo hay.
        const reason = await res.text().catch(() => '');
        setSendError(reason || 'No se pudo enviar el mensaje. Reintentá.');
      }
      setMessages((m) => reconcileSent(m, temp, saved));
    } catch {
      setSendError('No se pudo enviar el mensaje. Revisá tu conexión y reintentá.');
      setMessages((m) => m.map((msg) => msg === temp ? { ...msg, status: 'failed' } : msg));
    }
    setLoading(false);
    setTimeout(() => setCooldown(false), 2000);
  }

  // Reintenta un mensaje de texto fallido (los de media requieren re-adjuntar).
  async function retrySend(failed: Message) {
    if (loading || cooldown) return;
    if (parseMedia(failed.content)) return;
    setMessages((m) => m.filter((x) => x !== failed));
    await sendText(failed.content);
  }

  // Envía una plantilla aprobada (fallback cuando se cayó la ventana de 24h).
  async function sendTemplate(name: string) {
    if (templateSending) return;
    setTemplateSending(true);
    try {
      const res = await fetch('/api/messages/template', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ contactId, templateName: name }),
      });
      if (res.ok) {
        const saved = await res.json();
        setMessages((m) => (saved?.id && m.some((x) => x.id === saved.id)) ? m : [...m, saved]);
        if (saved?.error) {
          setSendError(saved.error); // la plantilla también falló (ej: no aprobada)
        } else {
          setSendError(null);
          setShowTemplates(false);
        }
      } else {
        const reason = await res.text().catch(() => '');
        setSendError(reason || 'No se pudo enviar la plantilla.');
      }
    } catch {
      setSendError('No se pudo enviar la plantilla. Revisá tu conexión.');
    } finally {
      setTemplateSending(false);
    }
  }

  async function handleSendImage() {
    if (!imageFile) return;
    const caption = input.trim();
    const preview = imagePreview;
    setImageFile(null); setImagePreview(null); setInput('');
    setLoading(true); setCooldown(true);
    const tempContent = JSON.stringify({ _type: 'image', url: preview ?? '', caption });
    const temp: Message = { role: 'human', content: tempContent, status: 'sending', agent_name: agent?.name, agent_role: agent?.role, agent_avatar: agent?.avatar_url };
    setMessages((m) => [...m, temp]);
    const form = new FormData();
    form.append('file', imageFile);
    form.append('contactId', contactId);
    form.append('caption', caption);
    setSendError(null);
    try {
      const res = await fetchWithTimeout('/api/messages/image', { method: 'POST', body: form }, 30000);
      const saved = (res.ok || res.status === 207) ? await res.json() : null;
      if (!saved || saved.status === 'failed') setSendError((saved as any)?.error || 'No se pudo enviar la imagen. Volvé a adjuntarla y reintentá.');
      setMessages((m) => reconcileSent(m, temp, saved));
    } catch {
      setSendError('No se pudo enviar la imagen. Revisá tu conexión y reintentá.');
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
    const temp: Message = { role: 'human', content: tempContent, status: 'sending', agent_name: agent?.name, agent_role: agent?.role, agent_avatar: agent?.avatar_url };
    setMessages((m) => [...m, temp]);
    const form = new FormData();
    const ext = blob.type.includes('ogg') ? 'ogg' : blob.type.includes('mp4') ? 'm4a' : blob.type.includes('mpeg') ? 'mp3' : 'webm';
    form.append('file', blob, `audio.${ext}`);
    form.append('contactId', contactId);
    setSendError(null);
    try {
      const res = await fetchWithTimeout('/api/messages/audio', { method: 'POST', body: form }, 30000);
      const saved = (res.ok || res.status === 207) ? await res.json() : null;
      if (!saved || saved.status === 'failed') setSendError((saved as any)?.error || 'No se pudo enviar el audio. Volvé a grabarlo y reintentá.');
      setMessages((m) => reconcileSent(m, temp, saved));
    } catch {
      setSendError('No se pudo enviar el audio. Revisá tu conexión y reintentá.');
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
    <div style={{ background: '#FFFFFF', borderRadius: '20px', padding: '20px', boxShadow: '0 2px 16px rgba(0,0,0,0.07)', display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>

      {/* Message list (scroller externo) + contenido observado por el RO.
          flex:1 + minHeight:0 → es el ÚNICO que scrollea; la caja queda fija abajo. */}
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
        {messages
          // Ocultar mensajes de reacción guardados como texto "reaction" (viejos,
          // de antes de manejar las reacciones como badge). No son burbujas.
          .filter((m) => m.content !== 'reaction' && (m as any).type !== 'reaction')
          .map((m, i) => {
          const isBot   = m.role === 'assistant';
          const isHuman = m.role === 'human';
          // Etiqueta superior solo para bot y cliente; el humano lleva firma abajo.
          const roleLabel = isBot ? 'Iris 🤖' : 'Cliente';
          // Firma del operador/agente debajo del mensaje manual (ej: "jessica · operador").
          // Si el mensaje no tiene autor guardado (mensajes viejos), no se muestra
          // firma (nada de "null" ni un genérico raro).
          const humanSignature = isHuman && m.agent_name
            ? `${m.agent_name}${m.agent_role ? ` · ${ROLE_LABEL[m.agent_role] ?? m.agent_role}` : ''}`
            : '';
          const media = parseMedia(m.content);
          // Solo se puede reaccionar a mensajes del cliente (tienen wamid).
          const reactable = m.role === 'user' && !!m.id && !!m.whatsapp_message_id;
          // "Enviar a verificar": solo en mensajes con imagen ya guardados (con id).
          //   entrante (cliente, role 'user')  → Cargas
          //   saliente del staff (role 'human', operador/agente) → Pagos
          // El bot (role 'assistant') y las promos sin imagen NO llevan botón:
          // un pago lo origina una imagen que mandó una persona del equipo.
          const hasImage   = media?._type === 'image' || classifyBody(m.content).kind === 'image';
          const canVerify  = hasImage && !!m.id && (m.role === 'user' || m.role === 'human');
          const verifSent  = !!m.id && verifSentIds.has(m.id);
          const verifDest  = m.role === 'user' ? 'Cargas' : 'Pagos';
          return (
            <div
              key={m.id ?? i}
              className="chat-msg"
              onMouseEnter={() => {
                if (reactBarLeaveTimer.current) clearTimeout(reactBarLeaveTimer.current);
                if (reactable) setReactBarFor(m.id!);
              }}
              onMouseLeave={() => {
                if (reactBarLeaveTimer.current) clearTimeout(reactBarLeaveTimer.current);
                reactBarLeaveTimer.current = setTimeout(() => setReactBarFor(null), 300);
              }}
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
              {!isHuman && (
                <p style={{ fontSize: '11px', fontWeight: 600, opacity: 0.6, margin: '0 0 4px 0' }}>
                  {roleLabel}
                </p>
              )}

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
                    onLoad={handleMediaLoad}
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
                      onLoad={handleMediaLoad}
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

              {/* "Enviar a verificar": solo en mensajes con imagen. Entrante →
                  Cargas; saliente → Pagos. Si ya se envió, queda marcado. */}
              {canVerify && (
                <div style={{ marginTop: '8px' }}>
                  {verifSent ? (
                    <span style={{
                      display: 'inline-flex', alignItems: 'center', gap: '5px',
                      fontSize: '12px', fontWeight: 700,
                      color: isBot || isHuman ? '#3a7a00' : '#C8FF00',
                      background: isBot || isHuman ? '#eaffd0' : '#2a2a2a',
                      borderRadius: '8px', padding: '5px 10px',
                    }}>
                      ✓ En verificación · {verifDest}
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => sendToVerify(m)}
                      disabled={verifSendingId === m.id}
                      title={`Mandar esta imagen a la bandeja de ${verifDest}`}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: '6px',
                        fontSize: '12px', fontWeight: 800, cursor: verifSendingId === m.id ? 'wait' : 'pointer',
                        color: '#000', background: '#C8FF00',
                        border: 'none', borderRadius: '8px', padding: '6px 12px',
                        boxShadow: '0 2px 0 #8ab000',
                      }}
                    >
                      {verifSendingId === m.id ? 'Enviando…' : `📤 Enviar a verificar`}
                    </button>
                  )}
                </div>
              )}

              {/* Hora + ticks (ticks solo en salientes) */}
              <p style={{ margin: '6px 0 0 0', fontSize: '11px', opacity: 0.5, display: 'flex', alignItems: 'center', gap: '5px', justifyContent: isBot || isHuman ? 'flex-start' : 'flex-end' }}
                 title={m.created_at ? new Date(m.created_at).toLocaleString('es-AR') : undefined}>
                {m.created_at && <span>{formatRelativeTime(m.created_at)}</span>}
                {(isBot || isHuman) && <Ticks status={m.status} />}
                {/* Acciones de mensaje fallido: reintentar texto libre o usar plantilla. */}
                {isHuman && m.status === 'failed' && (
                  <>
                    {!media && (
                      <button
                        type="button"
                        onClick={() => retrySend(m)}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#E53935', fontSize: '11px', fontWeight: 700, textDecoration: 'underline', padding: 0 }}
                      >
                        Reintentar
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setShowTemplates(true)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#1a7a3a', fontSize: '11px', fontWeight: 700, textDecoration: 'underline', padding: 0 }}
                    >
                      Usar plantilla
                    </button>
                  </>
                )}
              </p>

              {/* Firma de quién envió el mensaje manual (operador/agente/admin),
                  con su avatar (foto o iniciales). Solo si hay autor guardado;
                  los mensajes viejos sin autor no la muestran. */}
              {isHuman && humanSignature && (
                <span style={{ display: 'flex', alignItems: 'center', gap: '5px', margin: '4px 0 0 0' }}>
                  <Avatar url={m.agent_avatar} name={m.agent_name ?? ''} size={16} />
                  <span style={{ fontSize: '10px', fontWeight: 600, opacity: 0.55 }}>
                    {humanSignature}
                  </span>
                </span>
              )}

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
                  onMouseEnter={() => {
                    if (reactBarLeaveTimer.current) clearTimeout(reactBarLeaveTimer.current);
                    setReactBarFor(m.id!);
                  }}
                  onMouseLeave={() => setReactBarFor(null)}
                  style={{
                  position: 'absolute', top: '-44px', right: 0,
                  display: 'flex', gap: '2px',
                  background: '#fff', borderRadius: '999px', padding: '4px 6px', paddingBottom: '4px',
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
      </div>

      {/* Input area — fija abajo, no se encoge */}
      <div style={{ position: 'relative', flexShrink: 0 }} ref={qrPanelRef}>

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

        {/* Menú "+" — acciones colapsadas (rápidas / emoji / adjuntar) */}
        {showActions && (
          <div style={{ position: 'absolute', bottom: 'calc(100% + 8px)', left: 0, background: '#fff', borderRadius: '14px', boxShadow: '0 4px 24px rgba(0,0,0,0.16)', padding: '6px', zIndex: 50, display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '200px' }}>
            <button
              type="button"
              onClick={() => { setShowActions(false); setShowEmoji(false); setShowQR(true); }}
              style={actionItem}
              onMouseEnter={(e) => (e.currentTarget.style.background = '#F5F5F5')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
            ><span style={{ fontSize: '18px' }}>⚡</span> Respuestas rápidas</button>
            <button
              type="button"
              onClick={() => { setShowActions(false); setShowQR(false); setShowEmoji(true); }}
              style={actionItem}
              onMouseEnter={(e) => (e.currentTarget.style.background = '#F5F5F5')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
            ><span style={{ fontSize: '18px' }}>😊</span> Emoji</button>
            <button
              type="button"
              onClick={() => { setShowActions(false); clearAudio(); imageInputRef.current?.click(); }}
              style={actionItem}
              onMouseEnter={(e) => (e.currentTarget.style.background = '#F5F5F5')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
            ><span style={{ fontSize: '18px' }}>📎</span> Adjuntar imagen</button>
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

        {/* Hidden file inputs */}
        <input ref={imageInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleImageFileChange} />
        <input ref={audioInputRef} type="file" accept="audio/*" style={{ display: 'none' }} onChange={handleAudioFileChange} />

        {/* Error de envío visible (A3) */}
        {sendError && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', background: '#FDECEA', color: '#B71C1C', borderRadius: '12px', padding: '10px 14px', marginBottom: '10px', fontSize: '13px', flexWrap: 'wrap' }}>
            <span style={{ flex: 1, minWidth: '160px' }}>⚠ {sendError}</span>
            {is24hWindowError(sendError) && (
              <button
                type="button"
                onClick={() => setShowTemplates(true)}
                style={{ background: '#1a1a1a', color: '#C8FF00', border: 'none', borderRadius: '8px', padding: '6px 12px', fontSize: '12px', fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}
              >
                Usar plantilla
              </button>
            )}
            <button type="button" onClick={() => setSendError(null)} aria-label="Cerrar" style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#B71C1C', fontSize: '18px', lineHeight: 1, padding: '2px' }}>×</button>
          </div>
        )}

        <form onSubmit={handleSend} className="chat-input-row" style={{ display: 'flex', alignItems: 'flex-end', gap: '6px', background: '#fff', borderTop: '1px solid #eee', padding: '8px 12px' }}>

          {isRecording ? (
            /* Grabando: indicador con timer + botón detener */
            <>
              <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: '10px', height: '44px', padding: '0 10px', color: '#E53935', fontWeight: 700, fontSize: '14px' }}>
                <span style={{ display: 'inline-block', width: '10px', height: '10px', borderRadius: '50%', background: '#E53935', animation: 'pulse 1s infinite', flexShrink: 0 }} />
                Grabando… {formatSeconds(recordingSeconds)}
              </div>
              <button type="button" onClick={stopRecording} title="Detener grabación" aria-label="Detener grabación" className="wa-send-btn" style={{ background: '#E53935' }}>⏹</button>
            </>
          ) : audioBlob ? (
            /* Audio grabado: preview con reproductor + cancelar + enviar */
            <>
              <button type="button" onClick={clearAudio} title="Descartar audio" aria-label="Descartar audio" className="wa-icon-btn" style={{ color: '#E53935', fontSize: '18px' }}>🗑️</button>
              <audio controls src={audioPreviewUrl ?? undefined} style={{ flex: 1, minWidth: 0, height: '40px' }} />
              <button type="submit" disabled={!canSend} title="Enviar audio" aria-label="Enviar audio" className="wa-send-btn" style={{ background: canSend ? '#C8FF00' : '#e0e0e0', color: '#000' }}>
                {loading ? '…' : cooldown ? '✓' : (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M3 11.5 L21 3 L13.5 21 L11 13.5 Z" fill="#000" stroke="#000" strokeWidth="1.2" strokeLinejoin="round" />
                  </svg>
                )}
              </button>
            </>
          ) : (
            /* Estado normal: botón "+", textarea y micrófono/enviar */
            <>
              <button
                type="button"
                onClick={() => { setShowQR(false); setShowEmoji(false); setShowActions((v) => !v); }}
                title="Más acciones"
                aria-label="Más acciones"
                className="wa-icon-btn"
                style={{ background: showActions ? '#E8FFB0' : 'transparent', fontSize: '26px' }}
              >+</button>

              <textarea
                ref={textInputRef}
                rows={1}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
                onPaste={handlePasteImage}
                onFocus={(e) => e.currentTarget.scrollIntoView({ behavior: 'smooth', block: 'end' })}
                placeholder={imageFile ? 'Agregar descripción (opcional)...' : 'Escribí un mensaje... (podés pegar una imagen)'}
                style={{
                  flex: 1, minWidth: 0, resize: 'none', minHeight: '44px', maxHeight: `${TA_MAX_H}px`,
                  background: '#F5F5F5', border: 'none', borderRadius: '22px', padding: '11px 16px',
                  fontSize: '14px', lineHeight: '20px', color: '#1a1a1a', outline: 'none',
                  overflowY: 'auto', fontFamily: 'inherit',
                }}
              />

              {canSend ? (
                <button type="submit" title="Enviar" aria-label="Enviar" className="wa-send-btn" style={{ background: '#C8FF00', color: '#000' }}>
                  {loading ? '…' : cooldown ? '✓' : (
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <path d="M3 11.5 L21 3 L13.5 21 L11 13.5 Z" fill="#000" stroke="#000" strokeWidth="1.2" strokeLinejoin="round" />
                    </svg>
                  )}
                </button>
              ) : (
                <button type="button" onClick={startRecording} title="Grabar audio" aria-label="Grabar audio" className="wa-icon-btn">🎤</button>
              )}
            </>
          )}
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

      {/* Selector de plantillas (fallback ventana 24h) */}
      {showTemplates && (
        <div
          onClick={() => !templateSending && setShowTemplates(false)}
          style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            style={{ background: '#fff', borderRadius: '18px', padding: '20px', width: '100%', maxWidth: '440px', maxHeight: '80vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.35)' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
              <h3 style={{ fontSize: '17px', fontWeight: 800, color: '#000', margin: 0 }}>Enviar por plantilla</h3>
              <button type="button" onClick={() => !templateSending && setShowTemplates(false)} aria-label="Cerrar" style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#999', fontSize: '22px', lineHeight: 1, padding: '2px' }}>×</button>
            </div>
            <p style={{ fontSize: '12px', color: '#888', margin: '0 0 14px 0' }}>
              Pasaron más de 24&nbsp;h desde el último mensaje del cliente. Enviá una plantilla aprobada para reabrir la conversación.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {TEMPLATES.map((t) => (
                <button
                  key={t.name}
                  type="button"
                  onClick={() => sendTemplate(t.name)}
                  disabled={templateSending}
                  style={{
                    textAlign: 'left', background: '#F7F7F7', border: '1px solid #eee', borderRadius: '12px',
                    padding: '12px 14px', cursor: templateSending ? 'not-allowed' : 'pointer', opacity: templateSending ? 0.6 : 1,
                  }}
                >
                  <p style={{ margin: '0 0 4px 0', fontSize: '12px', fontWeight: 800, color: '#1a1a1a', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    ⚡ {t.name}
                    <span style={{ fontWeight: 600, color: '#aaa', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{t.language}</span>
                  </p>
                  <p style={{ margin: 0, fontSize: '13px', color: '#555', lineHeight: 1.45 }}>
                    {previewTemplate(t)}
                  </p>
                </button>
              ))}
            </div>

            {templateSending && (
              <p style={{ fontSize: '12px', color: '#888', textAlign: 'center', margin: '12px 0 0 0' }}>Enviando plantilla…</p>
            )}
          </div>
        </div>
      )}

      <style>{`
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
        /* Botones de la barra estilo WhatsApp */
        .wa-icon-btn {
          width: 40px; height: 40px; min-width: 40px; flex-shrink: 0; padding: 0;
          border: none; border-radius: 50%; background: transparent; color: #54656f;
          font-size: 20px; line-height: 1; cursor: pointer;
          display: flex; align-items: center; justify-content: center;
        }
        .wa-icon-btn:hover { background: #f0f2f5; }
        .wa-icon-btn:disabled { opacity: .4; cursor: not-allowed; }
        .wa-send-btn {
          width: 44px; height: 44px; min-width: 44px; flex-shrink: 0; padding: 0;
          border: none; border-radius: 50%; cursor: pointer; color: #fff; font-size: 18px;
          display: flex; align-items: center; justify-content: center;
        }
        /* Mobile: tap targets ≥ 44px */
        @media (max-width: 768px) {
          .wa-icon-btn { width: 44px; height: 44px; min-width: 44px; }
        }
      `}</style>
    </div>
  );
}
