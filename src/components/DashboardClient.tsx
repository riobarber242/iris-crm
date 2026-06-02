"use client";

import React, { useEffect, useState, useRef } from 'react';
import Link from 'next/link';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

type Stats = {
  convToday: number; convWeek: number; convMonth: number; convPrevMonth: number;
  newToday: number;  newWeek: number;  newMonth: number;  newPrevMonth: number;
  clienteActivoTotal: number; inactivoTotal: number; nuevoTotal: number; scheduledTotal: number;
  comprobantesPending: number;
  montoVerifHoy: number; montoVerifMes: number; montoVerifMesAnterior: number;
  sinResponder: number; activosHoy: number; totalEnProceso: number; totalDone: number;
};

function fmt(n: number) {
  return n.toLocaleString('es-AR');
}
function money(n: number) {
  return `$${n.toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

type MetricCardProps = { label: string; value: string; highlight?: boolean; href?: string };

function MetricCard({ label, value, highlight, href }: MetricCardProps) {
  const inner = (
    <div
      className={highlight ? 'card-3d-lime' : 'card-3d'}
      style={{
        background: highlight ? '#C8FF00' : '#FFFFFF',
        borderRadius: '16px',
        padding: '16px 18px',
        cursor: href ? 'pointer' : 'default',
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
  return href
    ? <Link href={href} style={{ textDecoration: 'none', display: 'block' }}>{inner}</Link>
    : inner;
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

    // Polling every 15 s — guaranteed refresh regardless of Realtime status
    const interval = setInterval(fetchStats, 15_000);

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL as string | undefined;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string | undefined;
    if (url && key) {
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
    }

    return () => {
      clearInterval(interval);
      try { if (channelRef.current) supabaseRef.current?.removeChannel(channelRef.current); } catch {}
    };
  }, []);

  if (!stats) {
    return (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '16px' }}>
        {[0, 1, 2, 3, 4].map((i) => (
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
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '16px' }}>

      {/* COLUMNA 1 — CONVERSACIONES — verde lima solo en HOY */}
      <Column title="Conversaciones" icon="💬">
        <MetricCard label="Hoy"          value={fmt(stats.convToday)}     highlight={stats.convToday > 0} href="/conversations" />
        <MetricCard label="Esta semana"  value={fmt(stats.convWeek)}                                      href="/conversations" />
        <MetricCard label="Este mes"     value={fmt(stats.convMonth)}                                     href="/conversations" />
        <MetricCard label="Mes anterior" value={fmt(stats.convPrevMonth)}                                 href="/conversations" />
      </Column>

      {/* COLUMNA 2 — CONTACTOS NUEVOS — sin highlight */}
      <Column title="Contactos nuevos" icon="👤">
        <MetricCard label="Hoy"          value={fmt(stats.newToday)}     href="/conversations" />
        <MetricCard label="Esta semana"  value={fmt(stats.newWeek)}      href="/conversations" />
        <MetricCard label="Este mes"     value={fmt(stats.newMonth)}     href="/conversations" />
        <MetricCard label="Mes anterior" value={fmt(stats.newPrevMonth)} href="/conversations" />
      </Column>

      {/* COLUMNA 3 — ESTADO DE CONTACTOS */}
      <Column title="Estado contactos" icon="📊">
        <MetricCard label="Agendados"      value={fmt(stats.scheduledTotal)}     highlight={stats.scheduledTotal > 0}     href="/contacts" />
        <MetricCard label="Cliente activo" value={fmt(stats.clienteActivoTotal)} highlight={stats.clienteActivoTotal > 0} href="/conversations" />
        <MetricCard label="Inactivo"       value={fmt(stats.inactivoTotal)}                                               href="/conversations" />
        <MetricCard label="Nuevo"          value={fmt(stats.nuevoTotal)}                                                  href="/conversations" />
      </Column>

      {/* COLUMNA 4 — PENDIENTES MANUAL — verde en SIN RESPONDER y ACTIVOS HOY */}
      <Column title="Pendientes manual" icon="👤">
        <MetricCard label="Sin responder"    value={fmt(stats.sinResponder)}   highlight={stats.sinResponder > 0} href="/conversations" />
        <MetricCard label="Activos hoy"      value={fmt(stats.activosHoy)}     highlight={stats.activosHoy > 0}   href="/conversations" />
        <MetricCard label="Total en proceso" value={fmt(stats.totalEnProceso)}                                    href="/conversations" />
        <MetricCard label="Total done"       value={fmt(stats.totalDone)}                                         href="/conversations" />
      </Column>

      {/* COLUMNA 5 — FINANZAS — verde solo en PENDIENTES */}
      <Column title="Finanzas" icon="💰">
        <MetricCard label="Pendientes"   value={fmt(stats.comprobantesPending)} highlight={stats.comprobantesPending > 0} href="/comprobantes" />
        <MetricCard label="Verif. hoy"   value={money(stats.montoVerifHoy)}                                               href="/comprobantes" />
        <MetricCard label="Verif. mes"   value={money(stats.montoVerifMes)}                                               href="/comprobantes" />
        <MetricCard label="Mes anterior" value={money(stats.montoVerifMesAnterior)}                                       href="/comprobantes" />
      </Column>

    </div>
  );
}
