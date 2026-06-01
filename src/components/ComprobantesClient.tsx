"use client";

import React, { useEffect, useState, useRef } from 'react';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

type ComprobanteItem = {
  id: string;
  image_url: string | null;
  monto: number | null;
  estado: 'pendiente' | 'verificado' | 'rechazado';
  created_at: string;
  contacts: { name: string | null; phone: string } | null;
};

const ESTADO_STYLE: Record<string, React.CSSProperties> = {
  pendiente:  { background: '#fffbe6', color: '#b8860b', border: '1px solid #f0c040' },
  verificado: { background: '#e8fff0', color: '#1a7a3a', border: '1px solid #5ad87a' },
  rechazado:  { background: '#fff0f0', color: '#c0392b', border: '1px solid #f08080' },
};

export default function ComprobantesClient() {
  const [comprobantes, setComprobantes]       = useState<ComprobanteItem[]>([]);
  const [loading, setLoading]                 = useState(true);
  const [error, setError]                     = useState<string | null>(null);
  const [lightbox, setLightbox]               = useState<string | null>(null);
  const [confirmingId, setConfirmingId]       = useState<string | null>(null);
  const [montoInput, setMontoInput]           = useState('');
  const [montoError, setMontoError]           = useState('');
  const [editingMontoId, setEditingMontoId]   = useState<string | null>(null);
  const [editMontoInput, setEditMontoInput]   = useState('');
  const supabaseRef                           = useRef<SupabaseClient | null>(null);
  const channelRef                            = useRef<any>(null);

  // Full fetch — shows spinner (initial load only)
  async function fetchComprobantes() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/comprobantes');
      if (!res.ok) throw new Error(res.statusText);
      setComprobantes(await res.json());
    } catch {
      setError('No se pudieron cargar los comprobantes.');
    } finally {
      setLoading(false);
    }
  }

  // Silent refresh — no spinner, no flicker (used by polling & Realtime)
  async function fetchSilent() {
    try {
      const res = await fetch('/api/comprobantes');
      if (!res.ok) return;
      setComprobantes(await res.json());
    } catch {}
  }

  async function updateComprobante(id: string, action: 'verificar' | 'rechazar', monto?: number) {
    try {
      const body: Record<string, any> = { comprobanteId: id, action };
      if (monto !== undefined) body.monto = monto;
      const res = await fetch('/api/comprobantes', {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await res.text());
      await fetchSilent();
    } catch {
      setError('No se pudo actualizar el comprobante.');
    }
  }

  async function confirmVerify(id: string) {
    const monto = parseFloat(montoInput.replace(',', '.'));
    if (!monto || monto <= 0) {
      setMontoError('Ingresá el monto antes de confirmar');
      return;
    }
    setMontoError('');
    setConfirmingId(null);
    setMontoInput('');
    await updateComprobante(id, 'verificar', monto);
  }

  async function saveMonto(id: string) {
    const monto = parseFloat(editMontoInput.replace(',', '.'));
    if (!monto || monto <= 0) return;
    try {
      const res = await fetch('/api/comprobantes', {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ comprobanteId: id, action: 'update_monto', monto }),
      });
      if (!res.ok) throw new Error(await res.text());
      setEditingMontoId(null);
      setEditMontoInput('');
      await fetchSilent();
    } catch {
      setError('No se pudo actualizar el monto.');
    }
  }

  useEffect(() => {
    fetchComprobantes();

    // Polling every 10 s — works even if Supabase Realtime isn't configured
    const interval = setInterval(fetchSilent, 10_000);

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL as string | undefined;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string | undefined;
    if (url && key) {
      supabaseRef.current = createClient(url, key);
      const ch = supabaseRef.current
        .channel('realtime-comprobantes')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'comprobantes' }, fetchSilent)
        .subscribe();
      channelRef.current = ch;
    }

    return () => {
      clearInterval(interval);
      try { if (channelRef.current) supabaseRef.current?.removeChannel(channelRef.current); } catch {}
    };
  }, []);

  if (loading) return (
    <div style={{ padding: '40px', textAlign: 'center', color: '#999', fontSize: '14px' }}>
      Cargando comprobantes...
    </div>
  );
  if (error) return (
    <div style={{ padding: '14px 18px', background: '#fff0f0', borderRadius: '12px', color: '#c0392b', fontSize: '14px' }}>
      {error}
    </div>
  );
  if (comprobantes.length === 0) return (
    <div style={{ padding: '40px', textAlign: 'center', color: '#999', fontSize: '14px' }}>
      No hay comprobantes cargados.
    </div>
  );

  return (
    <>
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
        {comprobantes.map((item) => {
          const estadoStyle = ESTADO_STYLE[item.estado] ?? ESTADO_STYLE.pendiente;
          const displayName = item.contacts?.name || item.contacts?.phone || '—';
          const phone       = item.contacts?.phone;
          const fecha       = new Date(item.created_at).toLocaleString('es-AR', {
            day: '2-digit', month: '2-digit', year: '2-digit',
            hour: '2-digit', minute: '2-digit',
          });

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
                  <span style={{
                    ...estadoStyle,
                    fontSize: '11px', fontWeight: 800,
                    letterSpacing: '0.06em', textTransform: 'uppercase',
                    padding: '3px 10px', borderRadius: '20px', whiteSpace: 'nowrap',
                  }}>
                    {item.estado}
                  </span>
                </div>

                {/* Row 2: fecha + monto + editar monto para verificados sin monto */}
                <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '12px', color: '#888' }}>{fecha}</span>
                  {editingMontoId === item.id ? (
                    <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                      <input
                        type="number" min="0.01" step="0.01"
                        value={editMontoInput}
                        onChange={(e) => setEditMontoInput(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') saveMonto(item.id); if (e.key === 'Escape') setEditingMontoId(null); }}
                        placeholder="Monto $" autoFocus
                        style={{ width: '110px', padding: '4px 8px', border: '2px solid #C8FF00', borderRadius: '8px', fontSize: '13px', fontWeight: 700, outline: 'none', background: '#f9ffe0' }}
                      />
                      <button onClick={() => saveMonto(item.id)} style={{ background: '#C8FF00', color: '#000', fontWeight: 700, fontSize: '11px', border: 'none', borderRadius: '8px', padding: '4px 10px', cursor: 'pointer' }}>✓</button>
                      <button onClick={() => setEditingMontoId(null)} style={{ background: 'transparent', color: '#888', fontWeight: 600, fontSize: '11px', border: '1px solid #ddd', borderRadius: '8px', padding: '4px 8px', cursor: 'pointer' }}>✕</button>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                      <span style={{ fontSize: '15px', fontWeight: 900, color: (!item.monto || item.monto === 0) ? '#E53935' : '#111' }}>
                        ${item.monto ?? 0}
                      </span>
                      {item.estado === 'verificado' && (!item.monto || item.monto === 0) && (
                        <button
                          onClick={() => { setEditingMontoId(item.id); setEditMontoInput(''); }}
                          style={{ background: '#fff3cd', color: '#856404', fontWeight: 700, fontSize: '11px', border: '1px solid #ffc107', borderRadius: '8px', padding: '3px 8px', cursor: 'pointer' }}
                        >
                          ✏ Editar monto
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {/* Row 3: action buttons (only for pending) */}
                {item.estado === 'pendiente' && (
                  confirmingId === item.id ? (
                    /* Inline monto input before confirming */
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '4px' }}>
                      <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                        <input
                          type="number"
                          min="0.01"
                          step="0.01"
                          value={montoInput}
                          onChange={(e) => { setMontoInput(e.target.value); setMontoError(''); }}
                          onKeyDown={(e) => { if (e.key === 'Enter') confirmVerify(item.id); if (e.key === 'Escape') { setConfirmingId(null); setMontoError(''); } }}
                          placeholder="Monto $"
                          autoFocus
                          style={{
                            width: '120px', padding: '5px 10px',
                            border: `2px solid ${montoError ? '#E53935' : '#C8FF00'}`,
                            borderRadius: '8px', fontSize: '13px', fontWeight: 700,
                            outline: 'none', background: montoError ? '#fff5f5' : '#f9ffe0',
                          }}
                        />
                        <button onClick={() => confirmVerify(item.id)} style={{ background: '#C8FF00', color: '#000', fontWeight: 700, fontSize: '12px', border: 'none', borderRadius: '8px', padding: '5px 12px', cursor: 'pointer', boxShadow: '0 2px 0 #8ab000' }}>
                          ✓ OK
                        </button>
                        <button onClick={() => { setConfirmingId(null); setMontoError(''); }} style={{ background: 'transparent', color: '#888', fontWeight: 700, fontSize: '12px', border: '1px solid #ddd', borderRadius: '8px', padding: '5px 10px', cursor: 'pointer' }}>
                          Cancelar
                        </button>
                      </div>
                      {montoError && (
                        <p style={{ margin: 0, fontSize: '11px', color: '#E53935', fontWeight: 600 }}>
                          {montoError}
                        </p>
                      )}
                    </div>
                  ) : (
                    <div style={{ display: 'flex', gap: '8px', marginTop: '2px' }}>
                      <button
                        onClick={() => { setConfirmingId(item.id); setMontoInput(item.monto && item.monto > 0 ? String(item.monto) : ''); }}
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
                  )
                )}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
