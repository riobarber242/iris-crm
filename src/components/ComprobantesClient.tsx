"use client";

import React, { useEffect, useState, useRef, useCallback } from 'react';
import Link from 'next/link';
import { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseBrowser } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import { formatRelativeTime } from '@/lib/formatRelativeTime';
import { thumbUrl } from '@/lib/thumb';
import PdfPreview from '@/components/PdfPreview';

// Detecta si el comprobante es un PDF (preview con pdf.js en vez de <img>).
const isPdfUrl = (u: string | null | undefined) => !!u && /\.pdf(\?|$)/i.test(u);

type ComprobanteItem = {
  id: string;
  contact_id: string;
  image_url: string | null;
  monto: number | null;
  bono: number | null;
  estado: 'pendiente' | 'verificado' | 'rechazado';
  created_at: string;
  // Quién resolvió (verificó/rechazó) el comprobante y cuándo. Pueden faltar en
  // comprobantes resueltos antes de que existiera el registro → no se muestran.
  resolved_by_name: string | null;
  resolved_at: string | null;
  // Última edición (botón "Editar" sobre un verificado). Null si nunca se editó.
  edited_by_name: string | null;
  edited_at: string | null;
  // El backend marca si esta sesión puede editar este comprobante.
  can_edit?: boolean;
  // Pago manual del agente (sin contacto): se muestra distinto en la lista.
  pago_agente?: boolean | null;
  contacts: { name: string | null; phone: string; casino_username: string | null } | null;
};

// "11 jun 11:16" — fecha corta + hora, es-AR. Vacío si la fecha es inválida.
function formatResolvedAt(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const fecha = d.toLocaleDateString('es-AR', { day: 'numeric', month: 'short' }).replace(/\.$/, '');
  const hora  = d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  return `${fecha} ${hora}`;
}

const ESTADO_STYLE: Record<string, React.CSSProperties> = {
  pendiente:  { background: '#fffbe6', color: '#b8860b', border: '1px solid #f0c040' },
  verificado: { background: '#e8fff0', color: '#1a7a3a', border: '1px solid #5ad87a' },
  rechazado:  { background: '#fff0f0', color: '#c0392b', border: '1px solid #f08080' },
};

type EstadoFilter = 'all' | 'pendiente' | 'verificado' | 'rechazado';

const ESTADO_FILTERS: { key: EstadoFilter; label: string }[] = [
  { key: 'all',       label: 'Todos' },
  { key: 'pendiente', label: 'Pendiente' },
  { key: 'verificado',label: 'Verificado' },
  { key: 'rechazado', label: 'Rechazado' },
];

// ── Card de comprobante (memoizada) ──────────────────────────────────────────
// Solo re-renderiza si cambian sus props: el item, sus flags (isConfirming/
// isDeleting) o los callbacks (que el padre pasa estables con useCallback). El
// estado del form (monto/bono) es LOCAL a la card → tipear en el form re-renderiza
// SOLO esta card, no las ~50 de la lista. Los cálculos por fila (fecha) corren solo
// cuando esta card realmente re-renderiza.
type ComprobanteCardProps = {
  item:        ComprobanteItem;
  tipo?:       'carga' | 'pago';
  canDelete:   boolean;
  isConfirming: boolean;
  isDeleting:  boolean;
  onLightbox:  (url: string) => void;
  onOpenForm:  (item: ComprobanteItem) => void;
  onCloseForm: () => void;
  onConfirm:   (item: ComprobanteItem, monto: number, bono: number | null) => void;
  onReject:    (item: ComprobanteItem) => void;
  onDelete:    (id: string) => void;
};

const ComprobanteCard = React.memo(function ComprobanteCard({
  item, tipo, canDelete, isConfirming, isDeleting,
  onLightbox, onOpenForm, onCloseForm, onConfirm, onReject, onDelete,
}: ComprobanteCardProps) {
  const [montoInput, setMontoInput] = useState('');
  const [bonoInput,  setBonoInput]  = useState('');
  const [montoError, setMontoError] = useState('');
  const [aiLoading,  setAiLoading]  = useState(false);

  // Al abrir el form, precargar monto/bono del item (verificar: detectado si lo
  // hubiera; editar: el guardado).
  useEffect(() => {
    if (isConfirming) {
      setMontoInput(item.monto && item.monto > 0 ? String(item.monto) : '');
      setBonoInput(item.bono && item.bono > 0 ? String(item.bono) : '');
      setMontoError('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConfirming]);

  async function detectMonto() {
    setAiLoading(true);
    try {
      const res = await fetch(`/api/comprobantes/analyze?id=${item.id}`);
      const data = await res.json();
      if (res.ok && data.monto > 0) { setMontoInput(String(data.monto)); setMontoError(''); }
      else setMontoError('No se pudo detectar el monto. Ingresalo manualmente.');
    } catch { setMontoError('Error al analizar la imagen.'); }
    setAiLoading(false);
  }

  function handleOk() {
    const monto = parseFloat(montoInput.replace(',', '.'));
    if (!monto || monto <= 0) { setMontoError('Ingresá el monto antes de confirmar'); return; }
    const raw = bonoInput.trim();
    const n = parseInt(raw, 10);
    const bono = raw === '' ? null : (Number.isInteger(n) && n > 0 ? n : null);
    onConfirm(item, monto, bono);
  }

  const estadoStyle = ESTADO_STYLE[item.estado] ?? ESTADO_STYLE.pendiente;
  const displayName = item.pago_agente
    ? '💸 Pago del agente'
    : (item.contacts?.casino_username || item.contacts?.phone || '—');
  const phone = item.contacts?.phone;

  return (
    <div style={{ background: '#fff', borderRadius: '16px', padding: '14px 16px', boxShadow: '0 2px 10px rgba(0,0,0,0.07)', display: 'flex', gap: '14px', alignItems: 'flex-start' }}>
      {/* ── Thumbnail ── */}
      <div
        style={{ width: '88px', height: '88px', flexShrink: 0, borderRadius: '12px', overflow: 'hidden', background: '#f0f0f0', cursor: item.image_url ? 'zoom-in' : 'default', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        onClick={() => { if (!item.image_url) return; if (isPdfUrl(item.image_url)) window.open(item.image_url, '_blank', 'noopener,noreferrer'); else onLightbox(item.image_url); }}
        title={!item.image_url ? 'Sin archivo' : isPdfUrl(item.image_url) ? 'Abrir PDF' : 'Ver imagen completa'}
      >
        {item.image_url ? (
          isPdfUrl(item.image_url) ? (
            <PdfPreview url={item.image_url} maxWidth={88} showLabel={false} />
          ) : (
            <img
              src={thumbUrl(item.image_url, 200) ?? item.image_url}
              alt="Comprobante"
              loading="lazy"
              style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = 'none';
                (e.target as HTMLImageElement).parentElement!.innerHTML =
                  '<span style="font-size:11px;color:#aaa;padding:4px;text-align:center;word-break:break-all;">Sin imagen</span>';
              }}
            />
          )
        ) : (
          <span style={{ fontSize: '11px', color: '#bbb', textAlign: 'center', padding: '4px' }}>Sin imagen</span>
        )}
      </div>

      {/* ── Info + actions ── */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {/* Row 1: name + badge */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
          <div style={{ minWidth: 0 }}>
            <p style={{ margin: 0, fontSize: '15px', fontWeight: 700, color: '#111', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{displayName}</p>
            {phone && displayName !== phone && (<p style={{ margin: 0, fontSize: '12px', color: '#888' }}>{phone}</p>)}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ ...estadoStyle, fontSize: '11px', fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase', padding: '3px 10px', borderRadius: '20px', whiteSpace: 'nowrap' }}>{item.estado}</span>
            {item.contact_id && (
              <Link href={`/conversaciones/${item.contact_id}`} title="Ver chat" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '28px', height: '28px', borderRadius: '8px', background: '#1a1a1a', textDecoration: 'none', fontSize: '14px', flexShrink: 0 }}>💬</Link>
            )}
            {canDelete && (
              <button
                onClick={() => onDelete(item.id)}
                disabled={isDeleting}
                title="Eliminar comprobante"
                style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '28px', height: '28px', borderRadius: '8px', border: 'none', background: '#FFE9E9', cursor: isDeleting ? 'not-allowed' : 'pointer', fontSize: '14px', flexShrink: 0, opacity: isDeleting ? 0.5 : 1 }}
              >🗑️</button>
            )}
          </div>
        </div>

        {/* Row 2: fecha + monto + bono */}
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '12px', color: '#888' }} title={new Date(item.created_at).toLocaleString('es-AR')}>{formatRelativeTime(item.created_at)}</span>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <span style={{ fontSize: '15px', fontWeight: 900, color: (!item.monto || item.monto === 0) ? '#E53935' : '#111' }}>${item.monto ?? 0}</span>
            {!!item.bono && item.bono > 0 && (
              <span title="Bono en fichas" style={{ fontSize: '12px', fontWeight: 800, color: '#7a5a00', background: '#fff3cd', border: '1px solid #ffe08a', borderRadius: '8px', padding: '2px 8px' }}>🎁 {item.bono}</span>
            )}
          </div>
        </div>

        {(item.estado === 'verificado' || item.estado === 'rechazado') && item.resolved_by_name && (
          <p style={{ margin: 0, fontSize: '11px', color: '#999' }}>
            {item.estado === 'verificado' ? 'Verificado' : 'Rechazado'} por {item.resolved_by_name}
            {item.resolved_at ? ` · ${formatResolvedAt(item.resolved_at)}` : ''}
          </p>
        )}
        {item.edited_at && item.edited_by_name && (
          <p style={{ margin: 0, fontSize: '11px', color: '#b58900' }}>Editado por {item.edited_by_name} · {formatResolvedAt(item.edited_at)}</p>
        )}

        {/* Row 3: form inline (verificar/editar) o botones */}
        {isConfirming ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '4px' }}>
            <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                type="number" min="0.01" step="0.01"
                value={montoInput}
                onChange={(e) => { setMontoInput(e.target.value); setMontoError(''); }}
                onKeyDown={(e) => { if (e.key === 'Enter') handleOk(); if (e.key === 'Escape') onCloseForm(); }}
                placeholder="Monto $" autoFocus
                style={{ width: '120px', padding: '5px 10px', border: `2px solid ${montoError ? '#E53935' : '#C8FF00'}`, borderRadius: '8px', fontSize: '13px', fontWeight: 700, outline: 'none', background: montoError ? '#fff5f5' : '#f9ffe0' }}
              />
              {tipo !== 'pago' && (
                <input
                  type="number" min="0" step="1"
                  value={bonoInput}
                  onChange={(e) => setBonoInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleOk(); if (e.key === 'Escape') onCloseForm(); }}
                  placeholder="Bono (fichas)"
                  style={{ width: '120px', padding: '5px 10px', border: '2px solid #ffe08a', borderRadius: '8px', fontSize: '13px', fontWeight: 700, outline: 'none', background: '#fffaf0' }}
                />
              )}
              {item.image_url && !isPdfUrl(item.image_url) && (
                <button
                  type="button" onClick={detectMonto} disabled={aiLoading}
                  title="Detectar monto con IA (no afecta el bono)"
                  style={{ background: aiLoading ? '#e0e0e0' : '#1a1a1a', color: aiLoading ? '#888' : '#C8FF00', fontWeight: 700, fontSize: '12px', border: 'none', borderRadius: '8px', padding: '5px 10px', cursor: aiLoading ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap' }}
                >{aiLoading ? '...' : '✨ IA'}</button>
              )}
              <button onClick={handleOk} style={{ background: '#C8FF00', color: '#000', fontWeight: 700, fontSize: '12px', border: 'none', borderRadius: '8px', padding: '5px 12px', cursor: 'pointer', boxShadow: '0 2px 0 #8ab000' }}>✓ OK</button>
              <button onClick={onCloseForm} style={{ background: 'transparent', color: '#888', fontWeight: 700, fontSize: '12px', border: '1px solid #ddd', borderRadius: '8px', padding: '5px 10px', cursor: 'pointer' }}>Cancelar</button>
            </div>
            {montoError && (<p style={{ margin: 0, fontSize: '11px', color: '#E53935', fontWeight: 600 }}>{montoError}</p>)}
          </div>
        ) : item.estado === 'pendiente' ? (
          <div style={{ display: 'flex', gap: '8px', marginTop: '2px' }}>
            <button onClick={() => onOpenForm(item)} style={{ background: '#C8FF00', color: '#000', fontWeight: 700, fontSize: '12px', border: 'none', borderRadius: '8px', padding: '5px 14px', cursor: 'pointer', boxShadow: '0 2px 0 #8ab000' }}>✓ Verificar</button>
            <button onClick={() => onReject(item)} style={{ background: '#1a1a1a', color: '#fff', fontWeight: 700, fontSize: '12px', border: 'none', borderRadius: '8px', padding: '5px 14px', cursor: 'pointer', boxShadow: '0 2px 0 #000' }}>✕ Rechazar</button>
          </div>
        ) : item.estado === 'verificado' && item.can_edit ? (
          <div style={{ display: 'flex', gap: '8px', marginTop: '2px', justifyContent: 'flex-end' }}>
            <button onClick={() => onOpenForm(item)} style={{ background: '#fff3cd', color: '#856404', fontWeight: 700, fontSize: '12px', border: '1px solid #ffc107', borderRadius: '8px', padding: '5px 14px', cursor: 'pointer' }}>✏ Editar</button>
          </div>
        ) : null}
      </div>
    </div>
  );
});

// `tipo` decide qué bandeja es: 'carga' (Cargas) o 'pago' (Pagos). Filtra el
// fetch al backend; si se omite, trae todo (compat). `canManualPago` (solo en
// Pagos, para admin/agent) habilita el botón "Cargar pago manual".
export default function ComprobantesClient(
  { tipo, canManualPago = false, canDelete = false }: { tipo?: 'carga' | 'pago'; canManualPago?: boolean; canDelete?: boolean } = {},
) {
  const [comprobantes, setComprobantes]       = useState<ComprobanteItem[]>([]);
  // tenant del usuario: filtra el postgres_changes por tenant (llega async → va en deps).
  const { agent } = useAuth();
  const tid = agent?.tenant_id ?? null;
  const [estadoFilter, setEstadoFilter]       = useState<EstadoFilter>('all');
  const [query,        setQuery]              = useState('');
  const [loading, setLoading]                 = useState(true);
  const [error, setError]                     = useState<string | null>(null);
  const [lightbox, setLightbox]               = useState<string | null>(null);
  // `confirmingId` = id del comprobante con el form abierto (verificar/editar). El
  // estado del form (monto/bono) ahora vive LOCAL en la ComprobanteCard.
  const [confirmingId, setConfirmingId]       = useState<string | null>(null);
  // Modal "Cargar pago manual" (solo Pagos · admin/agent).
  const [manualOpen,   setManualOpen]         = useState(false);
  const [manualMonto,  setManualMonto]        = useState('');
  const [manualFile,   setManualFile]         = useState<File | null>(null);
  const [manualError,  setManualError]        = useState('');
  const [manualSaving, setManualSaving]       = useState(false);
  const [deletingComprobanteId, setDeletingComprobanteId] = useState<string | null>(null);
  const supabaseRef                           = useRef<SupabaseClient | null>(null);
  const channelRef                            = useRef<any>(null);
  // Paginación keyset "cargar más". loadedCountRef evita el closure viejo en el
  // poll/realtime (fetchSilent refresca la ventana ya cargada, no solo la 1ª página).
  const [hasMore, setHasMore]                 = useState(false);
  const [loadingMore, setLoadingMore]         = useState(false);
  const loadedCountRef                        = useRef(0);
  const searchMountRef                        = useRef(true);
  const fetchSilentRef                         = useRef<() => void>(() => {});
  const PAGE_SIZE = 50;

  // Sustantivo de la bandeja para los textos (vacío/errores), según el tipo.
  // `artS` = artículo singular, `fem` = concuerda en femenino (cargas).
  const NOUN = tipo === 'pago'
    ? { sing: 'pago', plur: 'pagos', artS: 'el', fem: false }
    : tipo === 'carga'
      ? { sing: 'carga', plur: 'cargas', artS: 'la', fem: true }
      : { sing: 'comprobante', plur: 'comprobantes', artS: 'el', fem: false };

  function estadoUrl(f: EstadoFilter, opts?: { limit?: number; before?: ComprobanteItem }) {
    const params = new URLSearchParams();
    if (f !== 'all') params.set('estado', f);
    if (tipo) params.set('tipo', tipo);
    params.set('limit', String(opts?.limit ?? PAGE_SIZE));
    if (opts?.before) {
      params.set('before',   opts.before.created_at);
      params.set('beforeId', opts.before.id);
    }
    // Búsqueda server-side por usuario/teléfono. loadMore y fetchSilent la heredan
    // (leen `query` acá), así "Cargar más" pagina dentro del filtro y el poll lo respeta.
    if (query.trim()) params.set('q', query.trim());
    return `/api/comprobantes?${params.toString()}`;
  }

  // Full fetch — shows spinner (initial load only). Trae la 1ª página.
  async function fetchComprobantes(f: EstadoFilter = estadoFilter) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(estadoUrl(f));
      if (!res.ok) throw new Error(res.statusText);
      const items: ComprobanteItem[] = await res.json();
      setComprobantes(items);
      setHasMore(items.length === PAGE_SIZE);
    } catch {
      setError('No se pudo cargar la bandeja.');
    } finally {
      setLoading(false);
    }
  }

  // Silent refresh — no spinner (polling & Realtime). Refresca la VENTANA ya cargada
  // (limit = lo cargado) para no perder las páginas abiertas ni traer todo el histórico.
  async function fetchSilent() {
    try {
      const count = Math.max(PAGE_SIZE, loadedCountRef.current);
      const res = await fetch(estadoUrl(estadoFilter, { limit: count }));
      if (!res.ok) return;
      const items: ComprobanteItem[] = await res.json();
      setComprobantes(items);
      setHasMore(items.length === count);
    } catch {}
  }

  // "Cargar más": siguiente página con cursor keyset del último item. Appendea (dedup defensivo).
  async function loadMore() {
    if (loadingMore || !hasMore) return;
    const last = comprobantes[comprobantes.length - 1];
    if (!last) return;
    setLoadingMore(true);
    try {
      const res = await fetch(estadoUrl(estadoFilter, { before: last }));
      if (!res.ok) return;
      const more: ComprobanteItem[] = await res.json();
      setComprobantes((prev) => {
        const seen = new Set(prev.map((c) => c.id));
        return [...prev, ...more.filter((c) => !seen.has(c.id))];
      });
      setHasMore(more.length === PAGE_SIZE);
    } catch {} finally {
      setLoadingMore(false);
    }
  }

  function handleFilterChange(f: EstadoFilter) {
    setEstadoFilter(f);
    fetchComprobantes(f);
  }

  // Bono del input → number|null. Vacío = sin bono; el backend revalida (0 e
  // inválidos quedan en null).
  // Sustantivo de la bandeja para el mensaje de error (estable por `tipo`).
  const nounSing = tipo === 'pago' ? 'el pago' : tipo === 'carga' ? 'la carga' : 'el comprobante';

  // Todos los handlers que recibe la ComprobanteCard van con useCallback: sus deps
  // (estadoFilter/agent/tipo) NO cambian al tipear ni al hacer hover, así los props
  // de las cards quedan estables y React.memo saltea el re-render de la lista entera.

  // Optimista: si el nuevo estado sale del filtro activo, saca el item de la vista
  // (cola de Pendientes al verificar); si no, lo actualiza en el lugar preservando
  // `contacts` y demás.
  const patchComprobanteLocal = useCallback((id: string, patch: Partial<ComprobanteItem>) => {
    const leaves = estadoFilter !== 'all' && !!patch.estado && estadoFilter !== patch.estado;
    setComprobantes((prev) =>
      leaves ? prev.filter((c) => c.id !== id)
             : prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }, [estadoFilter]);

  const updateComprobante = useCallback(async (item: ComprobanteItem, action: 'verificar' | 'rechazar', monto?: number, bono?: number | null) => {
    // Optimista (mismo patrón que el borrado). El que resuelve siempre puede editar → can_edit: true.
    const nuevoEstado: ComprobanteItem['estado'] = action === 'verificar' ? 'verificado' : 'rechazado';
    patchComprobanteLocal(item.id, {
      estado:           nuevoEstado,
      monto:            action === 'verificar' ? (monto ?? item.monto ?? null) : (item.monto ?? null),
      bono:             action === 'verificar' ? (bono ?? item.bono ?? null)   : (item.bono ?? null),
      resolved_by_name: agent?.name ?? null,
      resolved_at:      new Date().toISOString(),
      can_edit:         true,
    });
    try {
      const body: Record<string, any> = { comprobanteId: item.id, action };
      if (monto !== undefined) body.monto = monto;
      if (bono  !== undefined) body.bono  = bono;
      const res = await fetch('/api/comprobantes', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await res.text());
      // Éxito: el cambio ya está en pantalla, sin refetch (win de fluidez).
    } catch (e: any) {
      const msg = String(e?.message ?? '').trim();
      setError(msg || `No se pudo actualizar ${nounSing}.`);
      fetchSilentRef.current(); // rollback: resincroniza con la verdad del server
    }
  }, [patchComprobanteLocal, agent, nounSing]);

  const editComprobante = useCallback(async (id: string, monto: number, bono: number | null) => {
    // Optimista: el estado NO cambia (se edita un verificado), solo monto/bono.
    patchComprobanteLocal(id, { monto, bono, edited_by_name: agent?.name ?? null, edited_at: new Date().toISOString() });
    try {
      const res = await fetch('/api/comprobantes', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comprobanteId: id, action: 'editar', monto, bono }),
      });
      if (!res.ok) throw new Error(await res.text());
    } catch (e: any) {
      const msg = String(e?.message ?? '').trim();
      setError(msg || `No se pudo editar ${nounSing}.`);
      fetchSilentRef.current(); // rollback
    }
  }, [patchComprobanteLocal, agent, nounSing]);

  const openForm  = useCallback((item: ComprobanteItem) => setConfirmingId(item.id), []);
  const closeForm = useCallback(() => setConfirmingId(null), []);

  // ✓ OK del form (la validación monto/bono la hace la card): verifica un pendiente
  // o edita un verificado.
  const onConfirm = useCallback((item: ComprobanteItem, monto: number, bono: number | null) => {
    closeForm();
    if (item.estado === 'pendiente') updateComprobante(item, 'verificar', monto, bono);
    else                             editComprobante(item.id, monto, bono);
  }, [closeForm, updateComprobante, editComprobante]);

  const onReject = useCallback((item: ComprobanteItem) => updateComprobante(item, 'rechazar'), [updateComprobante]);

  // Borra un comprobante (tachito). Pide confirmación; quita el item al instante.
  const handleDeleteComprobante = useCallback(async (id: string) => {
    if (!confirm('¿Eliminar este comprobante? Esta acción no se puede deshacer.')) return;
    setDeletingComprobanteId(id);
    try {
      const res = await fetch(`/api/comprobantes?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (res.ok) {
        setComprobantes((prev) => prev.filter((c) => c.id !== id));
      } else {
        const data = await res.json().catch(() => ({} as any));
        setError(data?.error || 'No se pudo eliminar el comprobante.');
      }
    } catch {
      setError('Error de red al eliminar el comprobante.');
    } finally {
      setDeletingComprobanteId(null);
    }
  }, []);

  function closeManual() {
    setManualOpen(false);
    setManualMonto('');
    setManualFile(null);
    setManualError('');
  }

  // Crea un pago manual del agente (premio pagado por afuera). Sube imagen
  // opcional + monto; entra como pago pendiente para verificar en esta bandeja.
  async function submitManual() {
    const monto = parseFloat(manualMonto.replace(',', '.'));
    if (!monto || monto <= 0) {
      setManualError('Ingresá el monto del pago');
      return;
    }
    setManualSaving(true);
    setManualError('');
    try {
      const fd = new FormData();
      fd.append('monto', String(Math.trunc(monto)));
      if (manualFile) fd.append('file', manualFile);
      const res = await fetch('/api/comprobantes/pago-manual', { method: 'POST', body: fd });
      if (!res.ok) throw new Error(await res.text());
      closeManual();
      await fetchSilent();
    } catch (e: any) {
      setManualError(e?.message ? String(e.message).slice(0, 140) : 'No se pudo cargar el pago.');
    } finally {
      setManualSaving(false);
    }
  }

  // Mantiene loadedCountRef al día para que fetchSilent (poll/realtime) refresque
  // la ventana ya cargada sin depender de un closure viejo.
  useEffect(() => { loadedCountRef.current = comprobantes.length; }, [comprobantes]);

  // fetchSilent siempre al día (evita el closure viejo en el poll/realtime/broadcast,
  // que si no refrescarían con el filtro/búsqueda del primer render).
  useEffect(() => { fetchSilentRef.current = fetchSilent; });

  // Fase 2: al recibir la señal de comprobante (via AdminShell), refresca al instante.
  useEffect(() => {
    const h = () => fetchSilentRef.current();
    window.addEventListener('iris:comprobante-broadcast', h);
    return () => window.removeEventListener('iris:comprobante-broadcast', h);
  }, []);

  // Búsqueda server-side con debounce: al tipear, reseteamos a la 1ª página con `q`.
  // Saltamos el primer render (el fetch inicial lo hace el effect de montaje de abajo).
  useEffect(() => {
    if (searchMountRef.current) { searchMountRef.current = false; return; }
    const h = setTimeout(() => fetchComprobantes(estadoFilter), 300);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  useEffect(() => {
    fetchComprobantes();

    // Poll de respaldo relajado a 30 s: la inmediatez la da el Broadcast de Fase 2
    // (iris:comprobante-broadcast). El poll queda de red de seguridad.
    const interval = setInterval(() => fetchSilentRef.current(), 30_000);

    const sb = getSupabaseBrowser();
    if (sb && tid) {
      supabaseRef.current = sb;
      const ch = sb
        .channel('realtime-comprobantes')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'comprobantes', filter: `tenant_id=eq.${tid}` }, () => fetchSilentRef.current())
        .subscribe();
      channelRef.current = ch;
    }

    return () => {
      clearInterval(interval);
      try { if (channelRef.current) supabaseRef.current?.removeChannel(channelRef.current); } catch (err) { console.warn('[comprobantes realtime] removeChannel falló:', err); }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tid]);

  // Botón + modal de carga manual de pago (solo Pagos · admin/agent). Se definen
  // acá para reusarlos en la vista vacía y en la vista con datos.
  const manualBtn = canManualPago && tipo === 'pago' ? (
    <button
      onClick={() => setManualOpen(true)}
      style={{
        background: '#1a7a3a', color: '#fff', fontWeight: 700, fontSize: '13px',
        border: 'none', borderRadius: '999px', padding: '6px 16px', cursor: 'pointer',
        boxShadow: '0 2px 0 #0f5527', whiteSpace: 'nowrap',
      }}
    >
      + Cargar pago manual
    </button>
  ) : null;

  const manualModal = manualOpen ? (
    <div
      onClick={closeManual}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: '#fff', borderRadius: '16px', padding: '20px', width: '100%', maxWidth: '380px', boxShadow: '0 10px 40px rgba(0,0,0,0.3)' }}
      >
        <h3 style={{ margin: '0 0 4px 0', fontSize: '17px', fontWeight: 800, color: '#111' }}>Cargar pago manual</h3>
        <p style={{ margin: '0 0 14px 0', fontSize: '13px', color: '#777' }}>
          Para premios pagados por afuera. Al verificarlo suben las fichas al pozo; no descuenta billetera de ningún operador.
        </p>

        <label style={{ display: 'block', fontSize: '12px', fontWeight: 700, color: '#555', marginBottom: '4px' }}>Monto $</label>
        <input
          type="number" min="1" step="1" value={manualMonto}
          onChange={(e) => { setManualMonto(e.target.value); setManualError(''); }}
          onKeyDown={(e) => { if (e.key === 'Enter') submitManual(); if (e.key === 'Escape') closeManual(); }}
          placeholder="Monto del pago" autoFocus
          style={{
            width: '100%', padding: '9px 12px', boxSizing: 'border-box',
            border: `2px solid ${manualError ? '#E53935' : '#1a7a3a'}`, borderRadius: '10px',
            fontSize: '15px', fontWeight: 700, outline: 'none', marginBottom: '12px',
          }}
        />

        <label style={{ display: 'block', fontSize: '12px', fontWeight: 700, color: '#555', marginBottom: '4px' }}>Comprobante (imagen, opcional)</label>
        <input
          type="file" accept="image/*"
          onChange={(e) => setManualFile(e.target.files?.[0] ?? null)}
          style={{ width: '100%', fontSize: '13px', marginBottom: '14px' }}
        />

        {manualError && (
          <p style={{ margin: '0 0 10px 0', fontSize: '12px', color: '#E53935', fontWeight: 600 }}>{manualError}</p>
        )}

        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <button onClick={closeManual} disabled={manualSaving} style={{ background: 'transparent', color: '#888', fontWeight: 700, fontSize: '13px', border: '1px solid #ddd', borderRadius: '10px', padding: '8px 14px', cursor: 'pointer' }}>
            Cancelar
          </button>
          <button onClick={submitManual} disabled={manualSaving} style={{ background: '#1a7a3a', color: '#fff', fontWeight: 800, fontSize: '13px', border: 'none', borderRadius: '10px', padding: '8px 18px', cursor: manualSaving ? 'wait' : 'pointer', boxShadow: '0 2px 0 #0f5527' }}>
            {manualSaving ? 'Guardando…' : 'Cargar pago'}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  if (loading) return (
    <div style={{ padding: '40px', textAlign: 'center', color: '#999', fontSize: '14px' }}>
      Cargando {NOUN.plur}...
    </div>
  );
  if (error) return (
    <div style={{ padding: '14px 18px', background: '#fff0f0', borderRadius: '12px', color: '#c0392b', fontSize: '14px' }}>
      {error}
    </div>
  );
  // Empty-state dedicado SOLO sin búsqueda activa (esa rama no tiene el input). Con
  // búsqueda que no matchea, caemos al render principal (con el buscador) + msg inline.
  if (comprobantes.length === 0 && !query.trim()) {
    const estadoAdj = estadoFilter === 'pendiente'
      ? 'pendientes'
      : estadoFilter === 'verificado'
        ? (NOUN.fem ? 'verificadas' : 'verificados')
        : (NOUN.fem ? 'rechazadas' : 'rechazados');
    const emptyMsg = estadoFilter === 'all'
      ? `No hay ${NOUN.plur} ${NOUN.fem ? 'registradas' : 'registrados'}.`
      : `No hay ${NOUN.plur} ${estadoAdj}.`;
    return (
      <>
        {manualModal}
        {/* ── Filter bar ── */}
        <div style={{ display: 'flex', gap: '8px', marginBottom: '12px', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {ESTADO_FILTERS.map(({ key, label }) => (
              <button
                key={key}
                onClick={() => handleFilterChange(key)}
                style={{
                  background:   estadoFilter === key ? '#C8FF00' : '#F0F0F0',
                  color:        estadoFilter === key ? '#000'    : '#888',
                  border:       'none', borderRadius: '999px',
                  padding:      '6px 16px', fontSize: '13px', fontWeight: 600, cursor: 'pointer',
                }}
              >
                {label}
              </button>
            ))}
          </div>
          {manualBtn}
        </div>
        <div style={{ padding: '40px', textAlign: 'center', color: '#999', fontSize: '14px' }}>
          {emptyMsg}
        </div>
      </>
    );
  }

  return (
    <>
      {manualModal}
      {/* ── Filter bar + search ── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '4px' }}>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {ESTADO_FILTERS.map(({ key, label }) => (
              <button
                key={key}
                onClick={() => handleFilterChange(key)}
                style={{
                  background:   estadoFilter === key ? '#C8FF00' : '#F0F0F0',
                  color:        estadoFilter === key ? '#000'    : '#888',
                  border:       'none', borderRadius: '999px',
                  padding:      '6px 16px', fontSize: '13px', fontWeight: 600, cursor: 'pointer',
                }}
              >
                {label}
              </button>
            ))}
          </div>
          {manualBtn}
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar por usuario casino o teléfono..."
          style={{
            width: '100%', padding: '10px 14px', fontSize: '14px',
            border: '2px solid #e0e0e0', borderRadius: '12px',
            outline: 'none', background: '#fff', boxSizing: 'border-box',
          }}
        />
      </div>

      {/* ── Lightbox ── */}
      {lightbox && (
        <div
          onClick={() => setLightbox(null)}
          style={{
            position: 'fixed', inset: 0, zIndex: 1000,
            background: 'rgba(0,0,0,0.88)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'zoom-out',
          }}
        >
          <img
            src={lightbox}
            alt="Comprobante"
            onClick={(e) => e.stopPropagation()}
            style={{
              maxWidth: '92vw', maxHeight: '90vh',
              borderRadius: '12px',
              boxShadow: '0 8px 40px rgba(0,0,0,0.6)',
              cursor: 'default',
            }}
          />
          <button
            onClick={() => setLightbox(null)}
            style={{
              position: 'absolute', top: '20px', right: '24px',
              background: 'rgba(255,255,255,0.12)', border: 'none',
              color: '#fff', fontSize: '22px', fontWeight: 700,
              borderRadius: '50%', width: '40px', height: '40px',
              cursor: 'pointer', lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>
      )}

      {/* ── Card list ── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {/* La búsqueda ahora es server-side (param `q`), no client-side sobre lo cargado. */}
        {comprobantes.length === 0 && query.trim() && (
          <div style={{ padding: '32px', textAlign: 'center', color: '#999', fontSize: '14px' }}>
            Sin resultados para “{query.trim()}”.
          </div>
        )}
        {comprobantes.map((item) => (
          <ComprobanteCard
            key={item.id}
            item={item}
            tipo={tipo}
            canDelete={canDelete}
            isConfirming={confirmingId === item.id}
            isDeleting={deletingComprobanteId === item.id}
            onLightbox={setLightbox}
            onOpenForm={openForm}
            onCloseForm={closeForm}
            onConfirm={onConfirm}
            onReject={onReject}
            onDelete={handleDeleteComprobante}
          />
        ))}

        {/* Paginación "cargar más": la bandeja ya no trae las ~1000 filas de una.
            La búsqueda es client-side sobre lo cargado; este botón trae más histórico. */}
        {hasMore && (
          <button
            onClick={loadMore}
            disabled={loadingMore}
            style={{
              alignSelf: 'center', marginTop: '4px',
              background: '#F0F0F0', color: '#555', fontWeight: 700, fontSize: '13px',
              border: '1px solid #e0e0e0', borderRadius: '10px', padding: '9px 20px',
              cursor: loadingMore ? 'default' : 'pointer', opacity: loadingMore ? 0.6 : 1,
            }}
          >
            {loadingMore ? 'Cargando…' : 'Cargar más'}
          </button>
        )}
      </div>
    </>
  );
}
