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
      if (!res.ok) {
        throw new Error(`Error cargando comprobantes: ${res.statusText}`);
      }
      const data = await res.json();
      setComprobantes(data);
    } catch (err) {
      console.error(err);
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
      if (!res.ok) {
        throw new Error(await res.text());
      }
      await fetchComprobantes();
    } catch (err) {
      console.error(err);
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
      .on('postgres_changes', { event: '*', schema: 'public', table: 'comprobantes' }, () => {
        fetchComprobantes();
      })
      .subscribe();

    channelRef.current = channel;

    return () => {
      try {
        if (channelRef.current) supabaseRef.current?.removeChannel(channelRef.current);
      } catch (e) {
        console.error('Error removing Supabase channel', e);
      }
    };
  }, []);

  return (
    <div className="space-y-6">
      {loading ? (
        <div className="rounded-[28px] border border-white/10 bg-[#14141c] p-8 text-white">Cargando comprobantes...</div>
      ) : error ? (
        <div className="rounded-[28px] border border-red-500 bg-[#2a1319] p-8 text-red-200">{error}</div>
      ) : comprobantes.length === 0 ? (
        <div className="rounded-[28px] border border-white/10 bg-[#14141c] p-8 text-white">No hay comprobantes cargados.</div>
      ) : (
        <div className="space-y-4">
          {comprobantes.map((item) => (
            <div key={item.id} className="rounded-[28px] border border-white/10 bg-[#14141c] p-5">
              <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                <div className="flex-1 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-lg font-semibold text-white">{item.contacts?.name || item.contacts?.phone}</p>
                      <p className="text-sm text-iris-text-muted">{item.contacts?.phone}</p>
                    </div>
                    <StatusBadge status={item.estado} />
                  </div>
                  <div className="rounded-3xl bg-iris-card p-4">
                    {item.image_url ? (
                      <img src={item.image_url} alt="Comprobante" className="h-[260px] w-full rounded-3xl object-cover" />
                    ) : (
                      <div className="flex h-[260px] items-center justify-center rounded-3xl border border-dashed border-white/10 bg-[#0d0d13] text-sm text-iris-text-muted">
                        Sin imagen disponible
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex w-full max-w-xs flex-col gap-4">
                  <div className="rounded-3xl bg-iris-card p-4">
                    <p className="text-sm text-iris-text-muted">Fecha y hora</p>
                    <p className="mt-1 text-base text-white">{new Date(item.created_at).toLocaleString('es-AR')}</p>
                  </div>
                  <div className="rounded-3xl bg-iris-card p-4">
                    <p className="text-sm text-iris-text-muted">Monto detectado</p>
                    <p className="mt-1 text-base text-white">${item.monto ?? '0'}</p>
                  </div>
                  <div className="flex flex-wrap gap-3">
                    <button
                      onClick={() => updateComprobante(item.id, 'verificar')}
                      className="rounded-2xl bg-iris-green px-4 py-2 text-sm font-semibold text-black"
                    >
                      Verificado
                    </button>
                    <button
                      onClick={() => updateComprobante(item.id, 'rechazar')}
                      className="rounded-2xl bg-iris-pink px-4 py-2 text-sm font-semibold text-white"
                    >
                      Rechazado
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
