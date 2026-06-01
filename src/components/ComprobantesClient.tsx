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
  const [comprobantes, setComprobantes] = useState<ComprobanteItem[]>([]);
  const [loading, setLoading]           = useState(true);
  const [error, setError]               = useState<string | null>(null);
  const [lightbox, setLightbox]         = useState<string | null>(null);
  const supabaseRef                     = useRef<SupabaseClient | null>(null);
  const channelRef                      = useRef<any>(null);

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

  async function updateComprobante(id: string, action: 'verificar' | 'rechazar') {
    try {
      const res = await fetch('/api/comprobantes', {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ comprobanteId: id, action }),
      });
      if (!res.ok) throw new Error(await res.text());
      await fetchComprobantes();
    } catch {
      setError('No se pudo actualizar el comprobante.');
    }
  }

  useEffect(() => {
    fetchComprobantes();
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL as string | undefined;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string | undefined;
    if (!url || !key) return;
    supabaseRef.current = createClient(url, key);
    const ch = supabaseRef.current
      .channel('realtime-comprobantes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'comprobantes' }, fetchComprobantes)
      .subscribe();
    channelRef.current = ch;
    return () => {
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

                {/* Row 2: fecha + monto */}
                <div style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
                  <span style={{ fontSize: '12px', color: '#888' }}>{fecha}</span>
                  <span style={{ fontSize: '15px', fontWeight: 900, color: '#111' }}>
                    ${item.monto ?? 0}
                  </span>
                </div>

                {/* Row 3: action buttons (only for pending) */}
                {item.estado === 'pendiente' && (
                  <div style={{ display: 'flex', gap: '8px', marginTop: '2px' }}>
                    <button
                      onClick={() => updateComprobante(item.id, 'verificar')}
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
                )}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
