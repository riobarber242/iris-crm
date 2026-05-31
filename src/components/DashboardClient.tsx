"use client";

import React, { useEffect, useState, useRef } from 'react';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

type Stats = {
  convToday: number; convWeek: number; convMonth: number; convPrevMonth: number;
  newToday: number;  newWeek: number;  newMonth: number;  newPrevMonth: number;
  vipTotal: number;  activoTotal: number; frioTotal: number;
  comprobantesPending: number;
  montoVerifHoy: number; montoVerifMes: number; montoVerifMesAnterior: number;
};

function fmt(n: number) {
  return n.toLocaleString('es-AR');
}
function money(n: number) {
  return `$${n.toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

type MetricCardProps = { label: string; value: string; highlight?: boolean };

function MetricCard({ label, value, highlight }: MetricCardProps) {
  return (
    <div
      className={highlight ? 'card-3d-lime' : 'card-3d'}
      style={{
        background: highlight ? '#C8FF00' : '#FFFFFF',
        borderRadius: '16px',
        padding: '16px 18px',
      }}
    >
      <p style={{
        fontSize: '11px',
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        color: highlight ? '#3a5a00' : '#999',
        margin: 0,
      }}>
        {label}
      </p>
      <p style={{
        fontSize: '32px',
        fontWeight: 900,
        color: '#000',
        margin: '6px 0 0 0',
        lineHeight: 1,
      }}>
        {value}
      </p>
    </div>
  );
}

type ColumnProps = { title: string; icon: string; children: React.ReactNode };

function Column({ title, icon, children }: ColumnProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div
        className="col-header-3d"
        style={{
          background: '#1a1a1a',
          borderRadius: '14px',
          padding: '12px 16px',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
        }}
      >
        <span style={{ fontSize: '16px' }}>{icon}</span>
        <h3 style={{
          fontSize: '13px',
          fontWeight: 700,
          color: '#fff',
          margin: 0,
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
        }}>
          {title}
        </h3>
      </div>
      {children}
    </div>
  );
}

export default function DashboardClient() {
  const [stats, setStats] = useState<Stats | null>(null);
  const supabaseRef = useRef<SupabaseClient | null>(null);
  const channelRef = useRef<any>(null);

  async function fetchStats() {
    try {
      const res = await fetch('/api/dashboard_stats');
      if (!res.ok) return;
      setStats(await res.json());
    } catch {}
  }

  useEffect(() => {
    fetchStats();

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL as string | undefined;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string | undefined;
    if (!url || !key) return;

    supabaseRef.current = createClient(url, key);
    const channel = supabaseRef.current
      .channel('realtime-dashboard')
      .on('postgres_changes', { event: '*',      schema: 'public', table: 'contacts' },     fetchStats)
      .on('postgres_changes', { event: '*',      schema: 'public', table: 'comprobantes' }, fetchStats)
      .on('postgres_changes', { event: '*',      schema: 'public', table: 'leads' },        fetchStats)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' },     fetchStats)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages' },     fetchStats)
      .subscribe();
    channelRef.current = channel;

    return () => {
      try { if (channelRef.current) supabaseRef.current?.removeChannel(channelRef.current); } catch {}
    };
  }, []);

  if (!stats) {
    return (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '16px' }}>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {[0, 1, 2, 3].map((j) => (
              <div key={j} style={{ background: '#F0F0F0', borderRadius: '16px', height: '80px' }} />
            ))}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '16px' }}>

      {/* COLUMNA 1 — CONVERSACIONES */}
      <Column title="Conversaciones" icon="💬">
        <MetricCard label="Hoy"          value={fmt(stats.convToday)}     highlight={stats.convToday > 0} />
        <MetricCard label="Esta semana"  value={fmt(stats.convWeek)} />
        <MetricCard label="Este mes"     value={fmt(stats.convMonth)} />
        <MetricCard label="Mes anterior" value={fmt(stats.convPrevMonth)} />
      </Column>

      {/* COLUMNA 2 — CONTACTOS NUEVOS */}
      <Column title="Contactos nuevos" icon="👤">
        <MetricCard label="Hoy"          value={fmt(stats.newToday)}     highlight={stats.newToday > 0} />
        <MetricCard label="Esta semana"  value={fmt(stats.newWeek)} />
        <MetricCard label="Este mes"     value={fmt(stats.newMonth)} />
        <MetricCard label="Mes anterior" value={fmt(stats.newPrevMonth)} />
      </Column>

      {/* COLUMNA 3 — ESTADO DE CONTACTOS */}
      <Column title="Estado contactos" icon="📊">
        <MetricCard label="VIP"    value={fmt(stats.vipTotal)}    highlight={stats.vipTotal > 0} />
        <MetricCard label="Activo" value={fmt(stats.activoTotal)} />
        <MetricCard label="Frío"   value={fmt(stats.frioTotal)} />
      </Column>

      {/* COLUMNA 4 — FINANZAS */}
      <Column title="Finanzas" icon="💰">
        <MetricCard label="Pendientes"     value={fmt(stats.comprobantesPending)} highlight={stats.comprobantesPending > 0} />
        <MetricCard label="Verif. hoy"     value={money(stats.montoVerifHoy)} />
        <MetricCard label="Verif. mes"     value={money(stats.montoVerifMes)} />
        <MetricCard label="Mes anterior"   value={money(stats.montoVerifMesAnterior)} />
      </Column>

    </div>
  );
}
