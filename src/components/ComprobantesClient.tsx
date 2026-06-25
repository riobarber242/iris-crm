"use client";

import React, { useEffect, useState, useRef } from 'react';
import Link from 'next/link';
import { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseBrowser } from '@/lib/supabase-browser';
import { formatRelativeTime } from '@/lib/formatRelativeTime';

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

// `tipo` decide qué bandeja es: 'carga' (Cargas) o 'pago' (Pagos). Filtra el
// fetch al backend; si se omite, trae todo (compat). `canManualPago` (solo en
// Pagos, para admin/agent) habilita el botón "Cargar pago manual".
export default function ComprobantesClient(
  { tipo, canManualPago = false, canDelete = false }: { tipo?: 'carga' | 'pago'; canManualPago?: boolean; canDelete?: boolean } = {},
) {
  const [comprobantes, setComprobantes]       = useState<ComprobanteItem[]>([]);
  const [estadoFilter, setEstadoFilter]       = useState<EstadoFilter>('all');
  const [query,        setQuery]              = useState('');
  const [loading, setLoading]                 = useState(true);
  const [error, setError]                     = useState<string | null>(null);
  const [lightbox, setLightbox]               = useState<string | null>(null);
  // Form inline único: sirve para verificar un pendiente y para editar un
  // verificado (monto + bono). `confirmingId` = id del comprobante con el form
  // abierto; la acción real se decide por el estado del item.
  const [confirmingId, setConfirmingId]       = useState<string | null>(null);
  const [montoInput, setMontoInput]           = useState('');
  const [bonoInput, setBonoInput]             = useState('');
  const [montoError, setMontoError]           = useState('');
  const [aiLoading,      setAiLoading]        = useState(false);
  // Modal "Cargar pago manual" (solo Pagos · admin/agent).
  const [manualOpen,   setManualOpen]         = useState(false);
  const [manualMonto,  setManualMonto]        = useState('');
  const [manualFile,   setManualFile]         = useState<File | null>(null);
  const [manualError,  setManualError]        = useState('');
  const [manualSaving, setManualSaving]       = useState(false);
  const [deletingComprobanteId, setDeletingComprobanteId] = useState<string | null>(null);
  const supabaseRef                           = useRef<SupabaseClient | null>(null);
  const channelRef                            = useRef<any>(null);

  // Sustantivo de la bandeja para los textos (vacío/errores), según el tipo.
  // `artS` = artículo singular, `fem` = concuerda en femenino (cargas).
  const NOUN = tipo === 'pago'
    ? { sing: 'pago', plur: 'pagos', artS: 'el', fem: false }
    : tipo === 'carga'
      ? { sing: 'carga', plur: 'cargas', artS: 'la', fem: true }
      : { sing: 'comprobante', plur: 'comprobantes', artS: 'el', fem: false };

  function estadoUrl(f: EstadoFilter) {
    const params = new URLSearchParams();
    if (f !== 'all') params.set('estado', f);
    if (tipo) params.set('tipo', tipo);
    const qs = params.toString();
    return qs ? `/api/comprobantes?${qs}` : '/api/comprobantes';
  }

  // Full fetch — shows spinner (initial load only)
  async function fetchComprobantes(f: EstadoFilter = estadoFilter) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(estadoUrl(f));
      if (!res.ok) throw new Error(res.statusText);
      setComprobantes(await res.json());
    } catch {
      setError('No se pudo cargar la bandeja.');
    } finally {
      setLoading(false);
    }
  }

  // Silent refresh — no spinner, no flicker (used by polling & Realtime)
  async function fetchSilent() {
    try {
      const res = await fetch(estadoUrl(estadoFilter));
      if (!res.ok) return;
      setComprobantes(await res.json());
    } catch {}
  }

  function handleFilterChange(f: EstadoFilter) {
    setEstadoFilter(f);
    fetchComprobantes(f);
  }

  // Bono del input → number|null. Vacío = sin bono; el backend revalida (0 e
  // inválidos quedan en null).
  function parseBono(): number | null {
    const raw = bonoInput.trim();
    if (raw === '') return null;
    const n = parseInt(raw, 10);
    return Number.isInteger(n) && n > 0 ? n : null;
  }

  async function updateComprobante(id: string, action: 'verificar' | 'rechazar', monto?: number, bono?: number | null) {
    try {
      const body: Record<string, any> = { comprobanteId: id, action };
      if (monto !== undefined) body.monto = monto;
      if (bono  !== undefined) body.bono  = bono;
      const res = await fetch('/api/comprobantes', {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await res.text());
      await fetchSilent();
    } catch (e: any) {
      // Mostramos el motivo real del backend (ej. "Saldo insuficiente en
      // billetera" / "No hay fichas suficientes"); genérico solo si vino vacío.
      const msg = String(e?.message ?? '').trim();
      setError(msg || `No se pudo actualizar ${NOUN.artS} ${NOUN.sing}.`);
    }
  }

  // Abre el form inline. Para pendiente precarga el monto detectado si lo hubiera;
  // para verificado (editar) precarga monto y bono guardados.
  function openForm(item: ComprobanteItem) {
    setConfirmingId(item.id);
    setMontoInput(item.monto && item.monto > 0 ? String(item.monto) : '');
    setBonoInput(item.bono && item.bono > 0 ? String(item.bono) : '');
    setMontoError('');
  }

  function closeForm() {
    setConfirmingId(null);
    setMontoInput('');
    setBonoInput('');
    setMontoError('');
  }

  // ✓ OK del form: verifica (si estaba pendiente) o edita (si ya estaba resuelto).
  async function confirmForm(item: ComprobanteItem) {
    const monto = parseFloat(montoInput.replace(',', '.'));
    if (!monto || monto <= 0) {
      setMontoError('Ingresá el monto antes de confirmar');
      return;
    }
    const bono = parseBono();
    closeForm();
    if (item.estado === 'pendiente') {
      await updateComprobante(item.id, 'verificar', monto, bono);
    } else {
      await editComprobante(item.id, monto, bono);
    }
  }

  async function editComprobante(id: string, monto: number, bono: number | null) {
    try {
      const res = await fetch('/api/comprobantes', {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ comprobanteId: id, action: 'editar', monto, bono }),
      });
      if (!res.ok) throw new Error(await res.text());
      await fetchSilent();
    } catch (e: any) {
      // Motivo real del backend (ej. guard de saldo/fichas al reaplicar).
      const msg = String(e?.message ?? '').trim();
      setError(msg || `No se pudo editar ${NOUN.artS} ${NOUN.sing}.`);
    }
  }

  // Borra un comprobante (tachito). Pide confirmación; quita el item al instante.
  async function handleDeleteComprobante(id: string) {
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
  }

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

  async function detectMonto(id: string) {
    setAiLoading(true);
    try {
      const res = await fetch(`/api/comprobantes/analyze?id=${id}`);
      const data = await res.json();
      if (res.ok && data.monto > 0) {
        setMontoInput(String(data.monto));
        setMontoError('');
      } else {
        setMontoError('No se pudo detectar el monto. Ingresalo manualmente.');
      }
    } catch {
      setMontoError('Error al analizar la imagen.');
    }
    setAiLoading(false);
  }

  useEffect(() => {
    fetchComprobantes();

    // Polling every 10 s — works even if Supabase Realtime isn't configured
    const interval = setInterval(fetchSilent, 10_000);

    const sb = getSupabaseBrowser();
    if (sb) {
      supabaseRef.current = sb;
      const ch = sb
        .channel('realtime-comprobantes')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'comprobantes' }, fetchSilent)
        .subscribe();
      channelRef.current = ch;
    }

    return () => {
      clearInterval(interval);
      try { if (channelRef.current) supabaseRef.current?.removeChannel(channelRef.current); } catch (err) { console.warn('[comprobantes realtime] removeChannel falló:', err); }
    };
  }, []);

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
  if (comprobantes.length === 0) {
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
        {comprobantes.filter((item) => {
          if (!query.trim()) return true;
          const q    = query.toLowerCase();
          const name = (item.contacts?.casino_username ?? '').toLowerCase();
          const ph   = (item.contacts?.phone ?? '').toLowerCase();
          return name.includes(q) || ph.includes(q);
        }).map((item) => {
          const estadoStyle = ESTADO_STYLE[item.estado] ?? ESTADO_STYLE.pendiente;
          const displayName = item.pago_agente
            ? '💸 Pago del agente'
            : (item.contacts?.casino_username || item.contacts?.phone || '—');
          const phone       = item.contacts?.phone;

          return (
            <div
              key={item.id}
              style={{
                background: '#fff',
                borderRadius: '16px',
                padding: '14px 16px',
                boxShadow: '0 2px 10px rgba(0,0,0,0.07)',
                display: 'flex',
                gap: '14px',
                alignItems: 'flex-start',
              }}
            >
              {/* ── Thumbnail ── */}
              <div
                style={{
                  width: '88px', height: '88px', flexShrink: 0,
                  borderRadius: '12px', overflow: 'hidden',
                  background: '#f0f0f0',
                  cursor: item.image_url ? 'zoom-in' : 'default',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
                onClick={() => item.image_url && setLightbox(item.image_url)}
                title={item.image_url ? 'Ver imagen completa' : 'Sin imagen'}
              >
                {item.image_url ? (
                  <img
                    src={item.image_url}
                    alt="Comprobante"
                    style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = 'none';
                      (e.target as HTMLImageElement).parentElement!.innerHTML =
                        '<span style="font-size:11px;color:#aaa;padding:4px;text-align:center;word-break:break-all;">Sin imagen</span>';
                    }}
                  />
                ) : (
                  <span style={{ fontSize: '11px', color: '#bbb', textAlign: 'center', padding: '4px' }}>
                    Sin imagen
                  </span>
                )}
              </div>

              {/* ── Info + actions ── */}
              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '6px' }}>

                {/* Row 1: name + badge */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
                  <div style={{ minWidth: 0 }}>
                    <p style={{ margin: 0, fontSize: '15px', fontWeight: 700, color: '#111', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {displayName}
                    </p>
                    {phone && displayName !== phone && (
                      <p style={{ margin: 0, fontSize: '12px', color: '#888' }}>{phone}</p>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{
                      ...estadoStyle,
                      fontSize: '11px', fontWeight: 800,
                      letterSpacing: '0.06em', textTransform: 'uppercase',
                      padding: '3px 10px', borderRadius: '20px', whiteSpace: 'nowrap',
                    }}>
                      {item.estado}
                    </span>
                    {item.contact_id && (
                      <Link
                        href={`/conversaciones/${item.contact_id}`}
                        title="Ver chat"
                        style={{
                          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                          width: '28px', height: '28px', borderRadius: '8px',
                          background: '#1a1a1a', textDecoration: 'none', fontSize: '14px',
                          flexShrink: 0,
                        }}
                      >
                        💬
                      </Link>
                    )}
                    {canDelete && (
                      <button
                        onClick={() => handleDeleteComprobante(item.id)}
                        disabled={deletingComprobanteId === item.id}
                        title="Eliminar comprobante"
                        style={{
                          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                          width: '28px', height: '28px', borderRadius: '8px', border: 'none',
                          background: '#FFE9E9', cursor: deletingComprobanteId === item.id ? 'not-allowed' : 'pointer',
                          fontSize: '14px', flexShrink: 0, opacity: deletingComprobanteId === item.id ? 0.5 : 1,
                        }}
                      >
                        🗑️
                      </button>
                    )}
                  </div>
                </div>

                {/* Row 2: fecha + monto + bono */}
                <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '12px', color: '#888' }} title={new Date(item.created_at).toLocaleString('es-AR')}>
                    {formatRelativeTime(item.created_at)}
                  </span>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                    <span style={{ fontSize: '15px', fontWeight: 900, color: (!item.monto || item.monto === 0) ? '#E53935' : '#111' }}>
                      ${item.monto ?? 0}
                    </span>
                    {!!item.bono && item.bono > 0 && (
                      <span
                        title="Bono en fichas"
                        style={{ fontSize: '12px', fontWeight: 800, color: '#7a5a00', background: '#fff3cd', border: '1px solid #ffe08a', borderRadius: '8px', padding: '2px 8px' }}
                      >
                        🎁 {item.bono}
                      </span>
                    )}
                  </div>
                </div>

                {/* Quién resolvió el comprobante (solo si el dato existe). */}
                {(item.estado === 'verificado' || item.estado === 'rechazado') && item.resolved_by_name && (
                  <p style={{ margin: 0, fontSize: '11px', color: '#999' }}>
                    {item.estado === 'verificado' ? 'Verificado' : 'Rechazado'} por {item.resolved_by_name}
                    {item.resolved_at ? ` · ${formatResolvedAt(item.resolved_at)}` : ''}
                  </p>
                )}

                {/* Última edición (monto/bono), si la hubo. */}
                {item.edited_at && item.edited_by_name && (
                  <p style={{ margin: 0, fontSize: '11px', color: '#b58900' }}>
                    Editado por {item.edited_by_name} · {formatResolvedAt(item.edited_at)}
                  </p>
                )}

                {/* Row 3: form inline (verificar pendiente / editar verificado) o botones */}
                {confirmingId === item.id ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '4px' }}>
                    <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                      <input
                        type="number"
                        min="0.01"
                        step="0.01"
                        value={montoInput}
                        onChange={(e) => { setMontoInput(e.target.value); setMontoError(''); }}
                        onKeyDown={(e) => { if (e.key === 'Enter') confirmForm(item); if (e.key === 'Escape') closeForm(); }}
                        placeholder="Monto $"
                        autoFocus
                        style={{
                          width: '120px', padding: '5px 10px',
                          border: `2px solid ${montoError ? '#E53935' : '#C8FF00'}`,
                          borderRadius: '8px', fontSize: '13px', fontWeight: 700,
                          outline: 'none', background: montoError ? '#fff5f5' : '#f9ffe0',
                        }}
                      />
                      {/* Bono en fichas: opcional, solo enteros positivos. La IA
                          no lo toca. Los pagos no llevan bono → se oculta. */}
                      {tipo !== 'pago' && (
                        <input
                          type="number"
                          min="0"
                          step="1"
                          value={bonoInput}
                          onChange={(e) => setBonoInput(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') confirmForm(item); if (e.key === 'Escape') closeForm(); }}
                          placeholder="Bono (fichas)"
                          style={{
                            width: '120px', padding: '5px 10px',
                            border: '2px solid #ffe08a',
                            borderRadius: '8px', fontSize: '13px', fontWeight: 700,
                            outline: 'none', background: '#fffaf0',
                          }}
                        />
                      )}
                      {item.image_url && (
                        <button
                          type="button"
                          onClick={() => detectMonto(item.id)}
                          disabled={aiLoading}
                          title="Detectar monto con IA (no afecta el bono)"
                          style={{
                            background: aiLoading ? '#e0e0e0' : '#1a1a1a',
                            color: aiLoading ? '#888' : '#C8FF00',
                            fontWeight: 700, fontSize: '12px',
                            border: 'none', borderRadius: '8px',
                            padding: '5px 10px', cursor: aiLoading ? 'not-allowed' : 'pointer',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {aiLoading ? '...' : '✨ IA'}
                        </button>
                      )}
                      <button onClick={() => confirmForm(item)} style={{ background: '#C8FF00', color: '#000', fontWeight: 700, fontSize: '12px', border: 'none', borderRadius: '8px', padding: '5px 12px', cursor: 'pointer', boxShadow: '0 2px 0 #8ab000' }}>
                        ✓ OK
                      </button>
                      <button onClick={closeForm} style={{ background: 'transparent', color: '#888', fontWeight: 700, fontSize: '12px', border: '1px solid #ddd', borderRadius: '8px', padding: '5px 10px', cursor: 'pointer' }}>
                        Cancelar
                      </button>
                    </div>
                    {montoError && (
                      <p style={{ margin: 0, fontSize: '11px', color: '#E53935', fontWeight: 600 }}>
                        {montoError}
                      </p>
                    )}
                  </div>
                ) : item.estado === 'pendiente' ? (
                  <div style={{ display: 'flex', gap: '8px', marginTop: '2px' }}>
                    <button
                      onClick={() => openForm(item)}
                      style={{
                        background: '#C8FF00', color: '#000',
                        fontWeight: 700, fontSize: '12px',
                        border: 'none', borderRadius: '8px',
                        padding: '5px 14px', cursor: 'pointer',
                        boxShadow: '0 2px 0 #8ab000',
                      }}
                    >
                      ✓ Verificar
                    </button>
                    <button
                      onClick={() => updateComprobante(item.id, 'rechazar')}
                      style={{
                        background: '#1a1a1a', color: '#fff',
                        fontWeight: 700, fontSize: '12px',
                        border: 'none', borderRadius: '8px',
                        padding: '5px 14px', cursor: 'pointer',
                        boxShadow: '0 2px 0 #000',
                      }}
                    >
                      ✕ Rechazar
                    </button>
                  </div>
                ) : item.estado === 'verificado' && item.can_edit ? (
                  // Alineado a la derecha, en línea con el badge de estado.
                  <div style={{ display: 'flex', gap: '8px', marginTop: '2px', justifyContent: 'flex-end' }}>
                    <button
                      onClick={() => openForm(item)}
                      style={{
                        background: '#fff3cd', color: '#856404',
                        fontWeight: 700, fontSize: '12px',
                        border: '1px solid #ffc107', borderRadius: '8px',
                        padding: '5px 14px', cursor: 'pointer',
                      }}
                    >
                      ✏ Editar
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
