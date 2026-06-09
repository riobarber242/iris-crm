"use client";

import React, { useEffect, useState, useRef, Fragment } from 'react';
import Link from 'next/link';
import { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseBrowser } from '@/lib/supabase-browser';
import { DonutChart, BarChart, ArgentinaMap, type ChartsData } from './DashboardCharts';
import DashboardCustomizer from './DashboardCustomizer';
import { DEFAULT_LAYOUT, WIDGET_GROUP, mergeLayout, type WidgetConfig } from '@/lib/dashboard-layout';

type Stats = {
  convToday: number; convWeek: number; convMonth: number; convPrevMonth: number;
  newToday: number;  newWeek: number;  newMonth: number;  newPrevMonth: number;
  conversionRate: number; clienteActivoTotal: number; inactivoTotal: number; nuevoTotal: number;
  avgFirstHumanResponseMin: number | null; recargasHoy: number; recargasMes: number; chatsActivosHoy: number;
  comprobantesPending: number;
  montoVerifMes: number; montoVerifMesAnterior: number; ticketPromedio: number;
  sinResponder: number;
  pendingOrange: number;
  pendingRed: number;
};

function fmt(n: number) {
  return n.toLocaleString('es-AR');
}
function money(n: number) {
  return `$${n.toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}
function pct(n: number) {
  return `${n.toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 1 })}%`;
}
// Operator first-response SLA: minutes when known, '—' when no human replies yet in the window.
function mins(n: number | null) {
  if (n === null) return '—';
  if (n < 1)   return `${Math.round(n * 60)}s`;
  if (n < 60)  return `${n.toLocaleString('es-AR', { maximumFractionDigits: 1 })} min`;
  return `${(n / 60).toLocaleString('es-AR', { maximumFractionDigits: 1 })} h`;
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

function ChartSkeleton() {
  return <div className="dash-chart" style={{ flex: 1, minWidth: '220px', background: '#F0F0F0', borderRadius: '14px', minHeight: '200px' }} />;
}

export default function DashboardClient() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [charts, setCharts] = useState<ChartsData | null>(null);
  const [layout, setLayout] = useState<WidgetConfig[]>(DEFAULT_LAYOUT);
  const [customizing, setCustomizing] = useState(false);
  const supabaseRef = useRef<SupabaseClient | null>(null);
  const channelRef = useRef<any>(null);

  async function fetchStats() {
    try {
      const res = await fetch('/api/dashboard_stats');
      if (!res.ok) return;
      setStats(await res.json());
    } catch {}
  }

  async function fetchCharts() {
    try {
      const res = await fetch('/api/dashboard_charts');
      if (!res.ok) return;
      setCharts(await res.json());
    } catch {}
  }

  useEffect(() => {
    fetchStats();
    fetchCharts();

    // Layout de personalización (mergeado con defaults en el server).
    fetch('/api/settings/dashboard-layout')
      .then((r) => r.json())
      .then((d) => { if (Array.isArray(d?.layout)) setLayout(mergeLayout(d.layout)); })
      .catch(() => {});

    // Polling every 15 s — guaranteed refresh regardless of Realtime status
    const interval = setInterval(() => { fetchStats(); fetchCharts(); }, 15_000);

    const sb = getSupabaseBrowser();
    if (sb) {
      supabaseRef.current = sb;
      const channel = sb
        .channel('realtime-dashboard')
        .on('postgres_changes', { event: '*',      schema: 'public', table: 'contacts' },     () => { fetchStats(); fetchCharts(); })
        .on('postgres_changes', { event: '*',      schema: 'public', table: 'comprobantes' }, () => { fetchStats(); fetchCharts(); })
        .on('postgres_changes', { event: '*',      schema: 'public', table: 'leads' },        fetchStats)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' },     fetchStats)
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages' },     fetchStats)
        .subscribe();
      channelRef.current = channel;
    }

    return () => {
      clearInterval(interval);
      try { if (channelRef.current) supabaseRef.current?.removeChannel(channelRef.current); } catch (err) { console.warn('[dashboard realtime] removeChannel falló:', err); }
    };
  }, []);

  async function saveLayout(next: WidgetConfig[]) {
    setLayout(next); // optimista
    setCustomizing(false);
    try {
      const res = await fetch('/api/settings/dashboard-layout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ layout: next }),
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok && Array.isArray(d?.layout)) setLayout(mergeLayout(d.layout));
    } catch {}
  }

  if (!stats) {
    return (
      <div className="dash-grid" style={{ gap: '16px' }}>
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

  const pendingOrange = stats.pendingOrange ?? 0;
  const pendingRed    = stats.pendingRed ?? 0;

  // Datos derivados para los charts (solo si ya cargaron).
  const contactData     = charts ? charts.contactsByStatus.map((d)     => ({ label: d.label, value: d.count, color: d.color })) : [];
  const comprobanteData = charts ? charts.comprobantesByEstado.map((d) => ({ label: d.label, value: d.count, color: d.color })) : [];
  const twoMonths       = charts ? charts.revenueByMonth.slice(-2) : [];

  function renderWidget(w: WidgetConfig): React.ReactNode {
    const s = stats!;
    switch (w.id) {
      case 'sin_responder': {
        const sinResponder = s.sinResponder;
        const hasPending   = sinResponder > 0;
        const heroBg   = pendingRed > 0 ? '#E53935' : pendingOrange > 0 ? '#FF8C00' : '#FFFFFF';
        const heroDot  = pendingRed > 0
          ? 'linear-gradient(145deg, #ff7a7a, #c62828)'
          : 'linear-gradient(145deg, #ffc164, #e67700)';
        return (
          <Link href="/conversations" style={{ textDecoration: 'none', display: 'block' }}>
            <div
              className={hasPending ? 'card-3d-lime' : 'card-3d'}
              style={{
                background: heroBg, borderRadius: '18px', padding: '20px 26px',
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                gap: '16px', cursor: 'pointer',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
                {hasPending ? (
                  <span style={{ width: '40px', height: '40px', borderRadius: '50%', background: heroDot, display: 'inline-block', flexShrink: 0 }} />
                ) : (
                  <span style={{ fontSize: '30px' }}>✅</span>
                )}
                <div>
                  <p style={{ fontSize: '12px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: hasPending ? 'rgba(255,255,255,0.85)' : '#999', margin: 0 }}>
                    {w.label}
                  </p>
                  <p style={{ fontSize: '14px', fontWeight: 600, color: hasPending ? '#fff' : '#666', margin: '4px 0 0 0' }}>
                    {hasPending ? 'Contactos esperando respuesta de un operador' : 'Todo respondido — sin pendientes'}
                  </p>
                  {hasPending && (
                    <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
                      {pendingOrange > 0 && (
                        <span style={{ background: '#FF8C00', color: '#fff', borderRadius: '999px', fontSize: '12px', fontWeight: 800, padding: '3px 10px' }}>
                          {fmt(pendingOrange)} naranja
                        </span>
                      )}
                      {pendingRed > 0 && (
                        <span style={{ background: '#fff', color: '#E53935', borderRadius: '999px', fontSize: '12px', fontWeight: 800, padding: '3px 10px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                          <span style={{ width: '10px', height: '10px', borderRadius: '50%', background: '#E53935', display: 'inline-block', flexShrink: 0 }} />
                          {fmt(pendingRed)} rojo
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
              <span style={{ fontSize: '52px', fontWeight: 900, color: hasPending ? '#fff' : '#000', lineHeight: 1 }}>
                {fmt(sinResponder)}
              </span>
            </div>
          </Link>
        );
      }

      case 'conversaciones':
        return (
          <Column title={w.label} icon="💬">
            <MetricCard label="Hoy"          value={fmt(s.convToday)}     highlight={s.convToday > 0} href="/conversations" />
            <MetricCard label="Esta semana"  value={fmt(s.convWeek)}                                  href="/conversations" />
            <MetricCard label="Este mes"     value={fmt(s.convMonth)}                                 href="/conversations" />
            <MetricCard label="Mes anterior" value={fmt(s.convPrevMonth)}                             href="/conversations" />
          </Column>
        );

      case 'contactos_nuevos':
        return (
          <Column title={w.label} icon="👤">
            <MetricCard label="Hoy"          value={fmt(s.newToday)}     href="/conversations" />
            <MetricCard label="Esta semana"  value={fmt(s.newWeek)}      href="/conversations" />
            <MetricCard label="Este mes"     value={fmt(s.newMonth)}     href="/conversations" />
            <MetricCard label="Mes anterior" value={fmt(s.newPrevMonth)} href="/conversations" />
          </Column>
        );

      case 'embudo_conversion':
        return (
          <Column title={w.label} icon="📊">
            <MetricCard label="Tasa de conversión" value={pct(s.conversionRate)}     highlight={s.conversionRate > 0}     href="/contacts" />
            <MetricCard label="Cliente activo"     value={fmt(s.clienteActivoTotal)} highlight={s.clienteActivoTotal > 0} href="/conversations" />
            <MetricCard label="Inactivo"           value={fmt(s.inactivoTotal)}                                           href="/conversations" />
            <MetricCard label="Nuevo"              value={fmt(s.nuevoTotal)}                                              href="/conversations" />
          </Column>
        );

      case 'operacion_finanzas':
        // Fusión de las columnas "Operación & recargas" + "Finanzas".
        return (
          <Column title={w.label} icon="⚡">
            <MetricCard label="Tiempo prom. 1ra resp." value={mins(s.avgFirstHumanResponseMin)}                       href="/conversations" />
            <MetricCard label="Recargas hoy"           value={fmt(s.recargasHoy)}  highlight={s.recargasHoy > 0}      href="/comprobantes" />
            <MetricCard label="Recargas mes"           value={fmt(s.recargasMes)}                                     href="/comprobantes" />
            <MetricCard label="Chats activos hoy"      value={fmt(s.chatsActivosHoy)}                                 href="/conversations" />
            <MetricCard label="Comprob. pendientes"    value={fmt(s.comprobantesPending)} highlight={s.comprobantesPending > 0} href="/comprobantes" />
            <MetricCard label="Verif. mes"             value={money(s.montoVerifMes)}                                 href="/comprobantes" />
            <MetricCard label="Mes anterior"           value={money(s.montoVerifMesAnterior)}                         href="/comprobantes" />
            <MetricCard label="Ticket promedio"        value={money(s.ticketPromedio)}                                href="/comprobantes" />
          </Column>
        );

      case 'estado_contactos':
        return charts ? <DonutChart data={contactData} title={w.label} emptyLabel="Sin contactos" /> : <ChartSkeleton />;

      case 'comprobantes_chart':
        return charts ? <DonutChart data={comprobanteData} title={w.label} emptyLabel="Sin comprobantes" /> : <ChartSkeleton />;

      case 'distribucion_provincia':
        return charts ? <ArgentinaMap data={charts.provinceData ?? []} title={w.label} /> : <ChartSkeleton />;

      case 'mes_anterior_actual':
        return charts ? <BarChart data={twoMonths} title={w.label} /> : <ChartSkeleton />;

      default:
        return null;
    }
  }

  const visible = [...layout].sort((a, b) => a.order - b.order).filter((w) => w.visible);
  const heroWidgets   = visible.filter((w) => WIDGET_GROUP[w.id] === 'hero');
  const metricWidgets = visible.filter((w) => WIDGET_GROUP[w.id] === 'metric');
  const chartWidgets  = visible.filter((w) => WIDGET_GROUP[w.id] === 'chart');

  return (
    <>
      {/* HERO + botón Personalizar: cuadrado a la derecha, misma altura que el widget */}
      <div style={{ display: 'flex', alignItems: 'stretch', gap: '12px', marginBottom: '16px' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {heroWidgets.map((w) => <Fragment key={w.id}>{renderWidget(w)}</Fragment>)}
        </div>
        <button
          onClick={() => setCustomizing(true)}
          aria-label="Personalizar dashboard"
          title="Personalizar"
          style={{ flexShrink: 0, alignSelf: 'stretch', aspectRatio: '1 / 1', background: '#1a1a1a', color: '#fff', border: 'none', borderRadius: '18px', fontSize: '22px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          ⚙
        </button>
      </div>

      {/* MÉTRICAS */}
      {metricWidgets.length > 0 && (
        <div className="dash-grid" style={{ gap: '16px' }}>
          {metricWidgets.map((w) => <Fragment key={w.id}>{renderWidget(w)}</Fragment>)}
        </div>
      )}

      {/* CHARTS */}
      {chartWidgets.length > 0 && (
        <div className="dash-charts" style={{ background: '#fff', borderRadius: '20px', padding: '24px', boxShadow: '0 2px 16px rgba(0,0,0,0.07)', marginTop: '8px', display: 'flex', gap: '32px', flexWrap: 'wrap', alignItems: 'flex-start' }}>
          {chartWidgets.map((w) => <Fragment key={w.id}>{renderWidget(w)}</Fragment>)}
        </div>
      )}

      {customizing && (
        <DashboardCustomizer
          layout={layout}
          onClose={() => setCustomizing(false)}
          onSave={saveLayout}
        />
      )}
    </>
  );
}
