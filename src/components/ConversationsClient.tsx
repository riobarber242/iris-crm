"use client";

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import Link from 'next/link';
import { getSupabaseBrowser } from '@/lib/supabase-browser';
import { formatRelativeTime } from '@/lib/formatRelativeTime';
import { classifyPending } from '@/lib/pending';
import { useAuth } from '@/components/AuthProvider';

// El sonido de pendiente nuevo lo dispara AdminShell (centralizado, suena en
// toda la app y diferencia naranja/rojo). Acá ya no se emite beep para no
// duplicarlo.

// Texto corto del último mensaje para la lista: media → etiqueta con emoji (no el
// JSON crudo). Refleja pending ("procesando…") y failed ("no disponible"), y cubre
// los literales viejos ('image', etc.). Alineado con previewOf/classifyBody.
function previewText(content: string | null | undefined): string {
  const c = (content ?? '').trim();
  if (!c) return '';
  const state = (p: any) => (p.pending ? ' · procesando…' : p.failed ? ' no disponible' : '');
  try {
    const p = JSON.parse(c);
    if (p?._type === 'image')    return `📷 Imagen${state(p)}`;
    if (p?._type === 'sticker')  return `🌟 Sticker${state(p)}`;
    if (p?._type === 'audio')    return `🎤 Audio${state(p)}`;
    if (p?._type === 'video')    return `🎬 Video${state(p)}`;
    if (p?._type === 'document') return p.pending || p.failed ? `📄 Documento${state(p)}` : `📄 ${p.filename || 'Documento'}`;
    if (p?._type === 'location') return '📍 Ubicación';
    if (p?._type === 'contacts') return '👤 Contacto';
    if (p?._type === 'campaign_event') return p.text || 'Interacción de campaña';
  } catch { /* texto plano o literal viejo */ }
  if (c === 'image')                  return '📷 Imagen';
  if (c === 'document')               return '📄 Documento';
  if (c === 'audio' || c === 'voice') return '🎤 Audio';
  if (c === 'sticker')                return '🌟 Sticker';
  if (c === 'video')                  return '🎬 Video';
  if (c === 'unsupported')            return '⚠️ Mensaje no compatible';
  return c;
}

type EstadoFiltro = 'todos' | 'nuevo' | 'cliente_activo' | 'inactivo' | 'bloqueado';

// Filas por página. La lista ya no viene entera: ver supabase-conversations-list-paginado.sql.
const PAGE_SIZE = 50;

const FILTERS: { key: EstadoFiltro; label: string }[] = [
  { key: 'todos',          label: 'Todos' },
  { key: 'nuevo',          label: 'Nuevo' },
  { key: 'cliente_activo', label: 'Cliente activo' },
  { key: 'inactivo',       label: 'Inactivo' },
  { key: 'bloqueado',      label: 'Bloqueado' },
];

// "No leído" = pendiente según classifyPending (naranja/rojo), misma regla
// que el badge de la lista. Solo frontend, sobre el array en memoria.
function isUnread(c: any): boolean {
  const lastMessage = (c.messages ?? [])[0];
  return !!classifyPending({
    lastRole:          lastMessage?.role,
    lastMsgAt:         lastMessage?.created_at,
    lastReadAt:        c.last_read_at,
    conversationState: c.conversation_state,
    humanTaken:        c.human_taken,
  });
}

// ─── Reconciliación que CONSERVA la identidad de los objetos ─────────────────
// Sin esto el memo de <ConversationRow/> no sirve de nada: cada refetch trae
// objetos nuevos (JSON.parse), así que las N filas verían props distintas y se
// re-renderizarían igual. Acá comparamos fila contra fila y, si el contenido es
// idéntico, devolvemos el objeto ANTERIOR: la fila memoizada corta ahí.
// Y si NINGUNA fila cambió, devolvemos el array anterior, con lo cual el propio
// setState no dispara render. Ese es el caso normal —entre dos polls la lista
// casi nunca cambia— y es lo que convierte los ~6 refetch/min en ~0 renders.
//
// La comparación es un JSON.stringify por fila A PROPÓSITO: comparar campo por
// campo es más rápido, pero se desactualiza en silencio en cuanto alguien suma
// una columna al render, y ese bug (fila congelada con datos viejos) es mucho
// peor que los ~5 ms que cuesta serializar la lista entera.
function reconcileConversations(prev: any[], next: any[]): any[] {
  const byId = new Map(prev.map((c) => [c.id, c]));
  let changed = prev.length !== next.length;
  const out = next.map((n, i) => {
    const old = byId.get(n.id);
    if (old && JSON.stringify(old) === JSON.stringify(n)) {
      if (prev[i] !== old) changed = true; // mismo objeto, otra posición → reordenó
      return old;
    }
    changed = true;
    return n;
  });
  return changed ? out : prev;
}

// ─── Fila de la lista (memoizada) ───────────────────────────────────────────
// Mismo criterio que <MessageList/> en ChatWindow: vive FUERA del componente y va
// envuelta en React.memo. Acá el padre re-renderiza por cosas que no tienen nada
// que ver con las filas —abrir el panel de Filtros, tipear en el buscador, el
// refetch de cada evento de Realtime— y sin el memo cada una de esas reconciliaba
// las ~857 tarjetas. Con el memo, un toggle de panel no toca ni una fila.
//
// Para que el memo NO se rompa, todo lo que baja acá tiene que ser estable entre
// renders: `contact` conserva su identidad gracias a reconcileConversations, el
// resto son primitivos y los handlers viajan en `h`, un objeto construido UNA
// sola vez (ver `rowHandlers` en el padre). Si sumás una prop nueva, que sea de
// ese mismo tipo: un objeto o una función literal por render devuelve el bug.
type RowHandlers = {
  saveScroll:    () => void;
  askDelete:     (id: string) => void;
  cancelDelete:  () => void;
  confirmDelete: (id: string) => void;
};

interface ConversationRowProps {
  contact:     any;
  canDelete:   boolean;
  confirmOpen: boolean;
  isDeleting:  boolean;
  h:           RowHandlers;
}

const ConversationRow = React.memo(function ConversationRow({
  contact, canDelete, confirmOpen, isDeleting, h,
}: ConversationRowProps) {
  const messages: any[] = contact.messages ?? [];
  const lastMessage     = messages[0];

  // Clasificación de pendiente (única fuente de verdad, compartida con la API).
  // El badge se limpia recién al ABRIR la conversación: el chat marca
  // last_read_at = NOW() server-side (ver conversaciones/[id]/page.tsx) y
  // la lista lo refleja en el próximo refetch (polling/realtime/remount).
  const badgeType = classifyPending({
    lastRole:          lastMessage?.role,
    lastMsgAt:         lastMessage?.created_at,
    lastReadAt:        contact.last_read_at,
    conversationState: contact.conversation_state,
    humanTaken:        contact.human_taken,
  });

  // Cantidad de entrantes sin leer (para el número del badge). Lo calcula la
  // RPC server-side (pending_count) para no tener que traer el historial completo:
  // COUNT de mensajes role<>'human' con created_at > last_read_at. Ver route.ts.
  const pendingCount = contact.pending_count ?? 0;

  const borderColor = badgeType === 'red' ? '#E53935'
                    : badgeType === 'orange' ? '#FF8C00'
                    : null;

  return (
    <Link
      href={`/conversaciones/${contact.id}`}
      onClick={h.saveScroll}
      style={{ textDecoration: 'none' }}
    >
      <div
        className="conv-row"
        style={{
          background: badgeType ? '#fffdf5' : '#FFFFFF',
          borderRadius: '16px',
          padding: '16px 20px',
          boxShadow: borderColor
            ? `0 1px 8px rgba(0,0,0,0.06), inset 3px 0 0 ${borderColor}`
            : '0 1px 8px rgba(0,0,0,0.06)',
          transition: 'background 0.2s, box-shadow 0.2s',
          cursor: 'pointer',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
          <div>
            <p style={{ fontSize: '15px', fontWeight: badgeType ? 800 : 700, color: '#000', margin: 0, display: 'flex', alignItems: 'center', gap: '7px' }}>
              {badgeType && (
                <span style={{
                  display: 'inline-block', width: '9px', height: '9px', borderRadius: '50%',
                  background: badgeType === 'red' ? '#E53935' : '#FF8C00', flexShrink: 0,
                }} />
              )}
              {(contact.casino_username ?? '').trim()
                || (contact.name ?? '').trim()
                || contact.phone}
            </p>
            <p style={{ fontSize: '12px', color: '#999', margin: '2px 0 0 0' }}>{contact.phone}</p>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {badgeType && pendingCount > 0 && (
              <span style={{
                background: badgeType === 'red' ? '#E53935' : '#FF8C00',
                color: '#fff',
                borderRadius: '999px',
                fontSize: '11px',
                fontWeight: 800,
                minWidth: '20px',
                height: '20px',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '0 6px',
              }}>
                {pendingCount > 99 ? '99+' : pendingCount}
              </span>
            )}
            <span style={{
              background: contact.status === 'cliente_activo' ? 'var(--status-activo)'
                        : contact.status === 'inactivo'        ? 'var(--status-inactivo)'
                        : contact.status === 'nuevo'           ? 'var(--status-nuevo)'
                        : '#F0F0F0',
              color: contact.status === 'cliente_activo' ? '#000'
                   : contact.status === 'inactivo'        ? '#fff'
                   : contact.status === 'nuevo'           ? '#000'
                   : '#888',
              borderRadius: '999px',
              padding: '4px 12px',
              fontSize: '11px',
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
            }}>
              {contact.status === 'cliente_activo' ? 'CLIENTE ACTIVO'
             : contact.status === 'inactivo'        ? 'INACTIVO'
             : contact.status === 'nuevo'           ? 'NUEVO'
             : contact.status === 'bloqueado'       ? 'BLOQUEADO'
             : (contact.status ?? '').toUpperCase()}
            </span>
            {canDelete && (
              <button
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); h.askDelete(contact.id); }}
                title="Eliminar conversación"
                style={{
                  background: '#FFE9E9', color: '#E53935', border: 'none', borderRadius: '8px',
                  width: '30px', height: '30px', display: 'inline-flex', alignItems: 'center',
                  justifyContent: 'center', cursor: 'pointer', fontSize: '14px', flexShrink: 0,
                }}
              >
                🗑
              </button>
            )}
          </div>
        </div>

        {canDelete && confirmOpen && (
          <div
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
            style={{ marginTop: '12px', display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', background: '#fff0f0', border: '1px solid #f0b0b0', borderRadius: '12px', padding: '10px 14px' }}
          >
            <span style={{ fontSize: '13px', fontWeight: 600, color: '#a02020' }}>
              ¿Eliminar esta conversación? Se borra el contacto y todo su historial. No se puede deshacer.
            </span>
            <button
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); h.confirmDelete(contact.id); }}
              disabled={isDeleting}
              style={{ background: '#E53935', color: '#fff', fontWeight: 700, fontSize: '12px', border: 'none', borderRadius: '8px', padding: '7px 12px', cursor: isDeleting ? 'not-allowed' : 'pointer', opacity: isDeleting ? 0.6 : 1 }}
            >
              {isDeleting ? 'Eliminando…' : 'Sí, eliminar'}
            </button>
            <button
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); h.cancelDelete(); }}
              style={{ background: '#F0F0F0', color: '#555', fontWeight: 700, fontSize: '12px', border: 'none', borderRadius: '8px', padding: '7px 12px', cursor: 'pointer' }}
            >
              Cancelar
            </button>
          </div>
        )}

        {lastMessage && (
          <div className="conv-preview" style={{ marginTop: '12px', background: '#F5F5F5', borderRadius: '12px', padding: '10px 14px' }}>
            <p style={{
              fontSize: '13px',
              color: badgeType ? '#333' : '#666',
              fontWeight: badgeType ? 600 : 400,
              margin: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>
              {previewText(lastMessage.content)}
            </p>
            <p style={{ fontSize: '11px', color: '#bbb', margin: '4px 0 0 0' }} title={new Date(lastMessage.created_at).toLocaleString('es-AR')}>
              {formatRelativeTime(lastMessage.created_at)}
            </p>
          </div>
        )}
      </div>
    </Link>
  );
});
export default function ConversationsClient() {
  const [conversations,  setConversations]  = useState<any[]>([]);
  const [activeFilter,   setActiveFilter]   = useState<EstadoFiltro>('todos');
  const [readFilter,     setReadFilter]     = useState<'todos' | 'no_leidos'>('todos');
  const [query,          setQuery]          = useState('');
  // Valor debounceado del buscador: el input se actualiza en cada tecla (no se
  // traba al tipear) pero el filtrado de la lista espera 250 ms. Sin esto cada
  // tecla re-filtraba y re-renderizaba las ~857 filas.
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [filtersOpen,    setFiltersOpen]    = useState(false);
  const [hasMore,        setHasMore]        = useState(false);
  const [loadingMore,    setLoadingMore]    = useState(false);
  // Cursor keyset de la última fila cargada: (created_at del último mensaje, id).
  const cursorRef = useRef<{ at: string; id: string } | null>(null);
  // Páginas cargadas. El refresco silencioso sólo pisa la lista si el usuario NO
  // paginó, para no arrancarle de abajo lo que ya venía scrolleando (mismo criterio
  // que el poll de ContactsClient).
  const pagesRef      = useRef(1);
  const loadingMoreRef = useRef(false);
  const sbRef          = useRef<any>(null);
  const channelRef     = useRef<any>(null);
  const filtersRef     = useRef<HTMLDivElement>(null);
  const listRef        = useRef<HTMLDivElement>(null);

  // Eliminar conversación (borra el contacto completo): SOLO rol agente.
  const { agent } = useAuth();
  const canDelete = agent?.role === 'agent';
  // tenant del usuario: filtra los postgres_changes para no recibir (ni re-fetchear
  // por) eventos de OTROS tenants. Llega async, por eso va en las deps del effect.
  const tid = agent?.tenant_id ?? null;
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleting,        setDeleting]        = useState<string | null>(null);

  // Número de filtros activos (estado distinto de "todos" + lectura distinta de "todos").
  const activeFilterCount = (activeFilter !== 'todos' ? 1 : 0) + (readFilter !== 'todos' ? 1 : 0);

  // Click fuera del panel de filtros → cerrar.
  useEffect(() => {
    if (!filtersOpen) return;
    function onClickOutside(e: MouseEvent) {
      if (filtersRef.current && !filtersRef.current.contains(e.target as Node)) {
        setFiltersOpen(false);
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [filtersOpen]);

  // Los filtros ahora viajan al SERVIDOR. Es obligatorio con la lista paginada:
  // filtrar en el cliente sólo miraría la página cargada y daría resultados falsos
  // ('no hay resultados' con la conversación buscada en la página 3).
  const buildParams = useCallback((cursor: { at: string; id: string } | null) => {
    const p = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (activeFilter !== 'todos')     p.set('status', activeFilter);
    if (readFilter === 'no_leidos')   p.set('unread', '1');
    if (debouncedQuery.trim())        p.set('search', debouncedQuery.trim());
    if (cursor) { p.set('before', cursor.at); p.set('beforeId', cursor.id); }
    return p;
  }, [activeFilter, readFilter, debouncedQuery]);

  const fetchPage = useCallback(async (cursor: { at: string; id: string } | null) => {
    const res = await fetch(`/api/conversations?${buildParams(cursor)}`);
    if (!res.ok) return null;
    const d = await res.json();
    return { rows: (d?.conversations ?? []) as any[], hasMore: !!d?.hasMore };
  }, [buildParams]);

  // Cursor de la última fila de una página, para pedir la siguiente.
  const cursorOf = (rows: any[]) => {
    const last = rows[rows.length - 1];
    const at   = last?.messages?.[0]?.created_at;
    return at && last?.id ? { at, id: last.id as string } : null;
  };

  // Primera página. `silent` = viene de un refresco automático (poll/Realtime).
  const loadFirst = useCallback(async (silent = false) => {
    // Si el usuario ya cargó más páginas, un refresco automático no la pisa: le
    // vaciaría la lista de golpe. La señal se retoma cuando vuelve arriba.
    if (silent && (pagesRef.current > 1 || loadingMoreRef.current)) return;
    try {
      const page = await fetchPage(null);
      if (!page) return;
      pagesRef.current   = 1;
      cursorRef.current  = cursorOf(page.rows);
      setHasMore(page.hasMore);
      // Conserva la identidad de las filas que no cambiaron (ver
      // reconcileConversations): si la respuesta es igual a lo que ya teníamos,
      // devuelve el MISMO array y React corta sin re-renderizar nada.
      setConversations((prev) => reconcileConversations(prev, page.rows));
    } catch {}
  }, [fetchPage]);

  async function loadMore() {
    if (loadingMoreRef.current || !hasMore || !cursorRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const page = await fetchPage(cursorRef.current);
      if (page) {
        pagesRef.current += 1;
        setHasMore(page.hasMore);
        setConversations((prev) => {
          // El keyset no puede repetir filas, pero si una conversación subió al tope
          // entre dos páginas igual la dedupeamos: una key repetida rompe el render.
          const vistos = new Set(prev.map((c) => c.id));
          const nuevos = page.rows.filter((c) => !vistos.has(c.id));
          return nuevos.length ? [...prev, ...nuevos] : prev;
        });
        if (page.rows.length) cursorRef.current = cursorOf(page.rows);
      }
    } catch {}
    loadingMoreRef.current = false;
    setLoadingMore(false);
  }

  // ─── Refresco coalescido: UN solo camino para los 6 disparadores ───────────
  // Antes cada señal llamaba a fetchConversations() por su cuenta y se pisaban:
  // un saliente dispara el INSERT, el broadcast y TRES UPDATE de status
  // (sent → delivered → read), o sea hasta 5 recargas de la lista completa en
  // pocos segundos, todas devolviendo prácticamente lo mismo.
  //
  // Ahora todos entran por scheduleRefresh(), que:
  //   · junta la ráfaga en una sola corrida (ventana de COALESCE_MS),
  //   · respeta un piso de MIN_GAP_MS entre dos refetch reales,
  //   · nunca solapa dos fetch: si llega una señal con uno en vuelo, se marca
  //     `dirty` y se corre UNA vez más al terminar (no se pierde la señal).
  // El poll de 60 s entra por el mismo lugar, así que tampoco puede solaparse
  // con una ráfaga de Realtime.
  const COALESCE_MS = 400;   // ventana para juntar la ráfaga
  const MIN_GAP_MS  = 3000;  // piso entre dos refetch reales
  const refreshRef = useRef<{
    timer: ReturnType<typeof setTimeout> | null;
    inFlight: boolean;
    dirty: boolean;
    last: number;
  }>({ timer: null, inFlight: false, dirty: false, last: 0 });

  // loadFirst cambia de identidad con cada filtro/tecla; scheduleRefresh tiene que
  // seguir siendo ESTABLE (si no, el efecto de los broadcasts se re-suscribe en cada
  // tecla). Por eso lo alcanza por ref.
  const loadFirstRef = useRef(loadFirst);
  useEffect(() => { loadFirstRef.current = loadFirst; });

  const scheduleRefresh = useCallback(() => {
    const s = refreshRef.current;
    if (s.timer) return; // ya hay una corrida agendada: esta señal se suma a esa
    const wait = Math.max(COALESCE_MS, MIN_GAP_MS - (Date.now() - s.last));
    s.timer = setTimeout(function run() {
      s.timer = null;
      if (s.inFlight) { s.dirty = true; return; }
      s.inFlight = true;
      s.last = Date.now();
      loadFirstRef.current(true).finally(() => {
        s.inFlight = false;
        // Llegó al menos una señal mientras fetcheábamos: una corrida más y listo.
        if (s.dirty) { s.dirty = false; s.timer = setTimeout(run, COALESCE_MS); }
      });
    }, wait);
  }, []);

  // Cancelar cualquier corrida pendiente al desmontar.
  useEffect(() => () => {
    const s = refreshRef.current;
    if (s.timer) { clearTimeout(s.timer); s.timer = null; }
  }, []);

  // Borra el contacto completo (cascada a mensajes/comprobantes/leads), via el
  // DELETE de /api/contacts (tenant-scoped). Quita el item del estado al instante.
  async function handleDelete(contactId: string) {
    setDeleting(contactId);
    try {
      const res = await fetch(`/api/contacts?id=${encodeURIComponent(contactId)}`, { method: 'DELETE' });
      if (res.ok) {
        setConversations((prev) => prev.filter((c) => c.id !== contactId));
        setConfirmDeleteId(null);
      } else {
        alert((await res.text().catch(() => '')) || 'No se pudo eliminar la conversación.');
      }
    } catch {
      alert('Error de red al eliminar.');
    } finally {
      setDeleting(null);
    }
  }

  // Debounce del buscador (250 ms). El input sigue respondiendo a cada tecla; lo
  // que se espacia es el filtrado + re-render de la lista.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 250);
    return () => clearTimeout(t);
  }, [query]);

  // Cualquier cambio de filtro o de búsqueda vuelve a la página 1 (ahora filtra el
  // servidor). También es la carga inicial: corre al montar.
  useEffect(() => {
    pagesRef.current  = 1;
    cursorRef.current = null;
    loadFirst();
  }, [loadFirst]);

  // Realtime (mensajes + contactos) con polling de respaldo cada 60 s.
  useEffect(() => {
    // Primer intento de restaurar el scroll al volver de una conversación. NO
    // limpiamos el valor acá: si la lista todavía no tiene altura, este scrollTo
    // queda corto y el refuerzo (dependiente de filtered.length) reintenta y
    // recién ahí borra el valor.
    const saved = sessionStorage.getItem('conv-scroll');
    if (saved) {
      const y = parseInt(saved, 10);
      requestAnimationFrame(() => window.scrollTo({ top: y, behavior: 'instant' }));
    }
    // Poll de respaldo espaciado (60 s): la actualización inmediata la dan el
    // Broadcast de Fase 2 (iris:message-broadcast) y el postgres_changes de abajo.
    // Este intervalo es solo red de seguridad por si se cae el canal Realtime.
    // Pasa por scheduleRefresh como todo lo demás: si justo viene de refrescar por
    // un evento, el piso de 3 s evita el refetch redundante.
    const timer = setInterval(() => scheduleRefresh(), 60_000);

    const sb = getSupabaseBrowser();
    if (sb && tid) {
      sbRef.current = sb;
      const trigger = () => scheduleRefresh();
      const f = `tenant_id=eq.${tid}`;
      const ch = sb.channel('realtime-conversations')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages',  filter: f }, trigger)
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages',  filter: f }, trigger)
        .on('postgres_changes', { event: '*',      schema: 'public', table: 'contacts',  filter: f }, trigger)
        .subscribe();
      channelRef.current = ch;
    }

    return () => {
      clearInterval(timer);
      try { if (channelRef.current) sbRef.current?.removeChannel(channelRef.current); } catch (err) { console.warn('[conversations realtime] removeChannel falló:', err); }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tid]);

  // Fase 2 — la señal de Realtime Broadcast la centraliza AdminShell (único
  // suscriptor del canal por tenant, por el dedup de canales de la librería) y la
  // reparte por este CustomEvent. Al recibirlo, re-fetcheamos la lista (ignoramos
  // el contact_id del payload). Aditivo: el postgres_changes y el polling de 5s de
  // arriba quedan de respaldo.
  useEffect(() => {
    function onBroadcast() { scheduleRefresh(); }
    window.addEventListener('iris:message-broadcast', onBroadcast);
    // Piggyback Fase 2: una verificación de comprobante puede cambiar el status del
    // contacto (→ badge/estado en la lista). Re-fetcheamos también con esa señal.
    window.addEventListener('iris:comprobante-broadcast', onBroadcast);
    return () => {
      window.removeEventListener('iris:message-broadcast', onBroadcast);
      window.removeEventListener('iris:comprobante-broadcast', onBroadcast);
    };
  }, [scheduleRefresh]);

  // Estado, búsqueda y paginación los resuelve el servidor. Acá queda UNA sola cosa:
  // afinar 'No leídos' con classifyPending, que es la única fuente de verdad y no se
  // replica en SQL (la RPC hace un pre-filtro conservador; ver la NOTA del .sql).
  const filtered = useMemo(
    () => (readFilter === 'no_leidos' ? conversations.filter(isUnread) : conversations),
    [conversations, readFilter],
  );

  // Refuerzo: cuando la lista ya tiene items renderizados (cambia filtered.length)
  // reintentamos restaurar el scroll si quedó un valor pendiente en sessionStorage.
  // Cubre el caso en que el primer intento (al montar) corrió antes de que la
  // lista tuviera altura. Recién acá limpiamos el valor.
  useEffect(() => {
    const saved = sessionStorage.getItem('conv-scroll');
    if (!saved || filtered.length === 0) return;
    const y = parseInt(saved, 10);
    sessionStorage.removeItem('conv-scroll');
    requestAnimationFrame(() => window.scrollTo({ top: y, behavior: 'instant' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered.length]);

  // Handlers de la fila con identidad FIJA. handleDelete se recrea en cada render
  // (cierra sobre estado), así que pasarlo derecho a <ConversationRow/> rompería su
  // memo en cada render del padre —justo lo que estamos evitando—. El ref guarda
  // siempre el último y los wrappers, creados una sola vez, delegan en él.
  const rowFnsRef = useRef({ handleDelete });
  useEffect(() => { rowFnsRef.current = { handleDelete }; });
  const rowHandlers = useMemo<RowHandlers>(() => ({
    saveScroll:    ()   => sessionStorage.setItem('conv-scroll', String(window.scrollY)),
    askDelete:     (id) => setConfirmDeleteId(id),
    cancelDelete:  ()   => setConfirmDeleteId(null),
    confirmDelete: (id) => rowFnsRef.current.handleDelete(id),
  }), []);

  return (
    <div ref={listRef} className="conv-list" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>

      {/* Barra: búsqueda + botón Filtros colapsable */}
      <div ref={filtersRef} style={{ position: 'relative', display: 'flex', gap: '8px', alignItems: 'stretch' }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar por usuario casino, nombre o teléfono..."
          style={{
            flex: 1,
            minWidth: 0,
            padding: '12px 16px',
            fontSize: '14px',
            border: '2px solid #e0e0e0',
            borderRadius: '12px',
            outline: 'none',
            background: '#fff',
            boxSizing: 'border-box',
          }}
        />

        <button
          onClick={() => setFiltersOpen((o) => !o)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            flexShrink: 0,
            padding: '0 16px',
            fontSize: '14px',
            fontWeight: 700,
            cursor: 'pointer',
            borderRadius: '12px',
            border: activeFilterCount > 0 ? '2px solid #F97316' : '2px solid #e0e0e0',
            background: activeFilterCount > 0 ? '#F97316' : '#fff',
            color: activeFilterCount > 0 ? '#fff' : '#555',
            transition: 'background 0.15s, color 0.15s, border-color 0.15s',
          }}
        >
          {/* Ícono de embudo */}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
          </svg>
          Filtros
          {activeFilterCount > 0 && (
            <span style={{
              background: '#fff',
              color: '#F97316',
              borderRadius: '999px',
              fontSize: '11px',
              fontWeight: 800,
              minWidth: '18px',
              height: '18px',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '0 5px',
            }}>
              {activeFilterCount}
            </span>
          )}
        </button>

        {/* Panel desplegable: full width en mobile, 320px alineado a la derecha en desktop */}
        {filtersOpen && (
          <div
            style={{
              position: 'absolute',
              top: 'calc(100% + 8px)',
              right: 0,
              left: 0,
              maxWidth: '320px',
              marginLeft: 'auto',
              background: '#fff',
              border: '2px solid #e0e0e0',
              borderRadius: '14px',
              boxShadow: '0 8px 28px rgba(0,0,0,0.12)',
              padding: '14px',
              zIndex: 20,
              display: 'flex',
              flexDirection: 'column',
              gap: '14px',
            }}
          >
            {/* Estado */}
            <div>
              <p style={{ fontSize: '11px', fontWeight: 700, color: '#999', margin: '0 0 8px 0', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Estado</p>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                {FILTERS.map(({ key, label }) => (
                  <button
                    key={key}
                    onClick={() => { setActiveFilter(key); setFiltersOpen(false); }}
                    style={{
                      background:   activeFilter === key ? '#C8FF00' : '#F0F0F0',
                      color:        activeFilter === key ? '#000'    : '#888',
                      border:       'none',
                      borderRadius: '999px',
                      padding:      '6px 16px',
                      fontSize:     '13px',
                      fontWeight:   600,
                      cursor:       'pointer',
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* Lectura */}
            <div>
              <p style={{ fontSize: '11px', fontWeight: 700, color: '#999', margin: '0 0 8px 0', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Lectura</p>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                {([['todos', 'Todos'], ['no_leidos', 'No leídos']] as const).map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => { setReadFilter(key); setFiltersOpen(false); }}
                    style={{
                      background:   readFilter === key ? '#F97316' : '#F0F0F0',
                      color:        readFilter === key ? '#fff'    : '#888',
                      border:       'none',
                      borderRadius: '999px',
                      padding:      '6px 16px',
                      fontSize:     '13px',
                      fontWeight:   600,
                      cursor:       'pointer',
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {filtered.length === 0 && (
        <div style={{ textAlign: 'center', padding: '40px 0', color: '#bbb', fontSize: '14px' }}>
          {query.trim()
            ? `Sin resultados para "${query}".`
            : readFilter === 'no_leidos'
              ? 'No hay conversaciones sin leer.'
              : activeFilter !== 'todos'
                ? `No hay conversaciones con estado "${activeFilter}".`
                : 'No hay conversaciones.'}
        </div>
      )}

      {filtered.map((contact) => (
        <ConversationRow
          key={contact.id}
          contact={contact}
          canDelete={canDelete}
          confirmOpen={confirmDeleteId === contact.id}
          isDeleting={deleting === contact.id}
          h={rowHandlers}
        />
      ))}

      {hasMore && (
        <button
          onClick={loadMore}
          disabled={loadingMore}
          style={{
            margin: '4px auto 0', padding: '10px 22px', fontSize: '13px', fontWeight: 700,
            color: '#555', background: '#fff', border: '2px solid #e0e0e0', borderRadius: '12px',
            cursor: loadingMore ? 'default' : 'pointer', opacity: loadingMore ? 0.6 : 1,
          }}
        >
          {loadingMore ? 'Cargando…' : 'Cargar más conversaciones'}
        </button>
      )}
    </div>
  );
}
// v2
