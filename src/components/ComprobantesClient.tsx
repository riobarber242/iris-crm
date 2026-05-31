"use client";

import React, { useEffect, useState, useRef } from 'react';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { StatusBadge } from '@/components/ui/StatusBadge';

type ComprobanteItem = {
  id: string;
  image_url: string | null;
  monto: number | null;
  estado: 'pendiente' | 'verificado' | 'rechazado';
  created_at: string;
  contacts: {
    name: string | null;
    phone: string;
  } | null;
};

const card: React.CSSProperties = {
  background: '#FFFFFF',
  borderRadius: '20px',
  padding: '20px',
  boxShadow: '0 2px 16px rgba(0,0,0,0.07)',
};

export default function ComprobantesClient() {
  const [comprobantes, setComprobantes] = useState<ComprobanteItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const supabaseRef = useRef<SupabaseClient | null>(null);
  const channelRef = useRef<any>(null);

  async function fetchComprobantes() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/comprobantes');
      if (!res.ok) throw new Error(`Error: ${res.statusText}`);
      setComprobantes(await res.json());
    } catch (err) {
      setError('No se pudieron cargar los comprobantes.');
    } finally {
      setLoading(false);
    }
  }

  async function updateComprobante(id: string, action: 'verificar' | 'rechazar') {
    try {
      const res = await fetch('/api/comprobantes', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comprobanteId: id, action }),
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
    const channel = supabaseRef.current
      .channel('realtime-comprobantes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'comprobantes' }, () => fetchComprobantes())
      .subscribe();
    channelRef.current = channel;
    return () => {
      try { if (channelRef.current) supabaseRef.current?.removeChannel(channelRef.current); } catch {}
    };
  }, []);

  if (loading) return <div style={{ padding: '32px', textAlign: 'center', color: '#999' }}>Cargando comprobantes...</div>;
  if (error) return <div style={{ padding: '16px', background: '#FFE5E5', borderRadius: '12px', color: '#CC3333' }}>{error}</div>;
  if (comprobantes.length === 0) return <div style={{ padding: '32px', textAlign: 'center', color: '#999' }}>No hay comprobantes cargados.</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {comprobantes.map((item) => (
        <div key={item.id} style={card}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {/* Header: nombre + badge */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
              <div>
                <p style={{ fontSize: '16px', fontWeight: 700, color: '#000', margin: 0 }}>
                  {item.contacts?.name || item.contacts?.phone}
                </p>
                <p style={{ fontSize: '13px', color: '#999', margin: '2px 0 0 0' }}>{item.contacts?.phone}</p>
              </div>
              <StatusBadge status={item.estado} />
            </div>

            {/* Imagen */}
            <div style={{ background: '#F5F5F5', borderRadius: '16px', overflow: 'hidden' }}>
              {item.image_url ? (
                <img
                  src={item.image_url}
                  alt="Comprobante"
                  style={{ width: '100%', maxHeight: '280px', objectFit: 'cover', display: 'block' }}
                />
              ) : (
                <div style={{ height: '180px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#bbb', fontSize: '14px' }}>
                  Sin imagen disponible
                </div>
              )}
            </div>

            {/* Metadata + botones */}
            <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
                <div>
                  <p style={{ fontSize: '11px', color: '#999', fontWeight: 600, textTransform: 'uppercase', margin: 0 }}>Fecha</p>
                  <p style={{ fontSize: '14px', fontWeight: 600, color: '#000', margin: '2px 0 0 0' }}>
                    {new Date(item.created_at).toLocaleString('es-AR')}
                  </p>
                </div>
                <div>
                  <p style={{ fontSize: '11px', color: '#999', fontWeight: 600, textTransform: 'uppercase', margin: 0 }}>Monto</p>
                  <p style={{ fontSize: '20px', fontWeight: 900, color: '#000', margin: '2px 0 0 0' }}>
                    ${item.monto ?? '0'}
                  </p>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '10px' }}>
                <button
                  onClick={() => updateComprobante(item.id, 'verificar')}
                  style={{
                    background: '#C8FF00',
                    color: '#000',
                    fontWeight: 700,
                    fontSize: '13px',
                    border: 'none',
                    borderRadius: '12px',
                    padding: '8px 20px',
                    cursor: 'pointer',
                    boxShadow: '0 4px 12px rgba(200,255,0,0.3)',
                  }}
                >
                  ✓ Verificar
                </button>
                <button
                  onClick={() => updateComprobante(item.id, 'rechazar')}
                  style={{
                    background: '#1a1a1a',
                    color: '#fff',
                    fontWeight: 700,
                    fontSize: '13px',
                    border: 'none',
                    borderRadius: '12px',
                    padding: '8px 20px',
                    cursor: 'pointer',
                  }}
                >
                  ✕ Rechazar
                </button>
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
