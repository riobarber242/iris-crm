"use client";

import React, { useEffect, useState, useRef, Fragment } from 'react';
import Link from 'next/link';
import { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseBrowser } from '@/lib/supabase-browser';
import { DonutChart, BarChart, ArgentinaMap, type ChartsData } from './DashboardCharts';
import DashboardCustomizer from './DashboardCustomizer';
import { DEFAULT_LAYOUT, widgetGroup, mergeLayout, type WidgetConfig } from '@/lib/dashboard-layout';
import { PERIODS, getMetric, metricKey, formatMetricValue } from '@/lib/dashboard-metrics';

type Stats = {
  convToday: number; convWeek: number; convMonth: number; convPrevMonth: number;
  newToday: number;  newWeek: number;  newMonth: number;  newPrevMonth: number;
  conversionRate: number; clienteActivoTotal: number; inactivoTotal: number; nuevoTotal: number;
  avgFirstHumanResponseMin: number | null; recargasHoy: number; recargasMes: number; chatsActivosHoy: number;
  comprobantesPending: number;
  montoVerifMes: number; montoVerifMesAnterior: number; ticketPromedio: number;
  recargasMesAnterior: number; ticketPromedioMesAnterior: number;
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
  const [customValues, setCustomValues] = useState<Record<string, number>>({});
  const [customizing, setCustomizing] = useState(false);
  const supabaseRef = useRef<SupabaseClient | null>(null);
  const channelRef = useRef<any>(null);
  // Última versión del layout, para que el polling (closure) refresque los
  // valores de los widgets custom sin re-crear el intervalo.
  const layoutRef = useRef<WidgetConfig[]>(DEFAULT_LAYOUT);

  // Junta los pares (métrica, período) que necesitan los widgets custom del
  // layout y pide sus valores al endpoint dedicado (deduplicado).
  async function fetchCustomMetrics(l: WidgetConfig[]) {
    const seen = new Set<string>();
    const pairs: { metric: string; period: string | null }[] = [];
    for (const w of l) {
      if (!w.custom) continue;
      const def = getMetric(w.custom.metric);
      if (!def) continue;
      const periods: (string | null)[] = !def.supportsPeriod
        ? [null]
        : w.custom.format === 'breakdown'
          ? PERIODS.map((p) => p.id)
          : [w.custom.period];
      for (const p of periods) {
        const k = metricKey(w.custom.metric, p as any);
        if (seen.has(k)) continue;
        seen.add(k);
        pairs.push({ metric: w.custom.metric, period: p });
      }
    }
    if (pairs.length === 0) { setCustomValues({}); return; }
    try {
      const res = await fetch('/api/dashboard_metric', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pairs }),
      });
      if (!res.ok) return;
      const d = await res.json();
      setCustomValues(d?.values ?? {});
    } catch {}
  }

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
      .then((d) => {
        const merged = Array.isArray(d?.layout) ? mergeLayout(d.layout) : DEFAULT_LAYOUT.map((w) => ({ ...w }));
        // Reset único: si quedaron widgets ocultos por una config vieja, los
        // volvemos visibles (orden canónico) y lo persistimos. Guardado con un
        // flag en localStorage para no pisar futuras personalizaciones.
        const anyHidden = merged.some((w) => !w.visible);
        let alreadyReset = false;
        try { alreadyReset = !!localStorage.getItem('dash-layout-reset-v1'); } catch {}
        if (anyHidden && !alreadyReset) {
          const reset = DEFAULT_LAYOUT.map((w) => ({ ...w }));
          setLayout(reset);
          layoutRef.current = reset;
          fetchCustomMetrics(reset);
          try { localStorage.setItem('dash-layout-reset-v1', '1'); } catch {}
          fetch('/api/settings/dashboard-layout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ layout: reset }),
          }).catch(() => {});
        } else {
          setLayout(merged);
          layoutRef.current = merged;
          fetchCustomMetrics(merged);
        }
      })
      .catch(() => {});

    // Polling every 15 s — guaranteed refresh regardless of Realtime status
    const interval = setInterval(() => { fetchStats(); fetchCharts(); fetchCustomMetrics(layoutRef.current); }, 15_000);

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
    layoutRef.current = next;
    setCustomizing(false);
    fetchCustomMetrics(next); // muestra valores de widgets recién creados ya mismo
    try {
      const res = await fetch('/api/settings/dashboard-layout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ layout: next }),
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok && Array.isArray(d?.layout)) {
        const merged = mergeLayout(d.layout);
        setLayout(merged);
        layoutRef.current = merged;
      }
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

  function renderCustomWidget(w: WidgetConfig): React.ReactNode {
    const spec = w.custom!;
    const def = getMetric(spec.metric);
    if (!def) return null;
    const valueFor = (period: string | null) => {
      const v = customValues[metricKey(spec.metric, period as any)];
      return v == null ? '—' : formatMetricValue(def.type, v);
    };
    // Desglose por los 4 períodos (solo métricas con período).
    if (def.supportsPeriod && spec.format === 'breakdown') {
      return (
        <Column title={w.label} icon="📌">
          {PERIODS.map((p) => <MetricCard key={p.id} label={p.label} value={valueFor(p.id)} />)}
        </Column>
      );
    }
    // Número único: un período elegido, o una métrica de estado (sin período).
    const period = def.supportsPeriod ? spec.period : null;
    const cardLabel = def.supportsPeriod ? (PERIODS.find((p) => p.id === spec.period)?.label ?? 'Valor') : def.label;
    const raw = customValues[metricKey(spec.metric, period as any)];
    return (
      <Column title={w.label} icon="📌">
        <MetricCard label={cardLabel} value={valueFor(period)} highlight={(raw ?? 0) > 0} />
      </Column>
    );
  }

  function renderWidget(w: WidgetConfig): React.ReactNode {
    if (w.custom) return renderCustomWidget(w);
    const s = stats!;
    switch (w.id) {
      case 'sin_responder': {
        const sinResponder = s.sinResponder;
        const hasPending   = sinResponder > 0;
        const heroBg   = pendingRed > 0 ? '#E53935' : pendingOrange > 0 ? '#FF8C00' : '#FFFFFF';
        const heroDot  = pendingRed > 0
          ? 'radial-gradient(circle at 35% 35%, #ff8a8a, #d32f2f)'
          : 'radial-gradient(circle at 35% 35%, #ffdd44, #ff8800)';
        const heroShadow = pendingRed > 0
          ? '0 4px 12px rgba(220,40,40,0.6), inset 0 -3px 6px rgba(0,0,0,0.2)'
          : '0 4px 12px rgba(255,120,0,0.6), inset 0 -3px 6px rgba(0,0,0,0.2)';
        return (
          <Link href="/conversaciones" style={{ textDecoration: 'none', display: 'block' }}>
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
                  <span style={{ width: '40px', height: '40px', borderRadius: '50%', background: heroDot, boxShadow: heroShadow, display: 'inline-block', flexShrink: 0 }} />
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
                        <span style={{ background: '#FF8C00', color: '#fff', borderRadius: '999px', fontSize: '12px', fontWeight: 800, padding: '3px 10px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                          <span style={{ width: '10px', height: '10px', borderRadius: '50%', background: 'radial-gradient(circle at 35% 35%, #ffdd44, #ff8800)', boxShadow: '0 2px 6px rgba(255,120,0,0.6), inset 0 -2px 3px rgba(0,0,0,0.2)', display: 'inline-block', flexShrink: 0 }} />
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
            <MetricCard label="Hoy"          value={fmt(s.convToday)}     highlight={s.convToday > 0} href="/conversaciones" />
            <MetricCard label="Esta semana"  value={fmt(s.convWeek)}                                  href="/conversaciones" />
            <MetricCard label="Este mes"     value={fmt(s.convMonth)}                                 href="/conversaciones" />
            <MetricCard label="Mes anterior" value={fmt(s.convPrevMonth)}                             href="/conversaciones" />
          </Column>
        );

      case 'contactos_nuevos':
        return (
          <Column title={w.label} icon="👤">
            <MetricCard label="Hoy"          value={fmt(s.newToday)}     href="/conversaciones" />
            <MetricCard label="Esta semana"  value={fmt(s.newWeek)}      href="/conversaciones" />
            <MetricCard label="Este mes"     value={fmt(s.newMonth)}     href="/conversaciones" />
            <MetricCard label="Mes anterior" value={fmt(s.newPrevMonth)} href="/conversaciones" />
          </Column>
        );

      case 'embudo_conversion':
        return (
          <Column title={w.label} icon="📊">
            <MetricCard label="Tasa de conversión" value={pct(s.conversionRate)}     highlight={s.conversionRate > 0}     href="/contactos" />
            <MetricCard label="Cliente activo"     value={fmt(s.clienteActivoTotal)} highlight={s.clienteActivoTotal > 0} href="/conversaciones" />
            <MetricCard label="Inactivo"           value={fmt(s.inactivoTotal)}                                           href="/conversaciones" />
            <MetricCard label="Nuevo"              value={fmt(s.nuevoTotal)}                                              href="/conversaciones" />
          </Column>
        );

      case 'finanzas':
        return (
          <Column title={w.label} icon="💰">
            <MetricCard label="Recargas hoy"            value={fmt(s.recargasHoy)}         highlight={s.recargasHoy > 0}          href="/cargas" />
            <MetricCard label="Recargas mes"            value={fmt(s.recargasMes)}                                                href="/cargas" />
            <MetricCard label="Recargas mes anterior"   value={fmt(s.recargasMesAnterior)}                                        href="/cargas" />
            <MetricCard label="Comprobantes pendientes" value={fmt(s.comprobantesPending)} highlight={s.comprobantesPending > 0}   href="/cargas" />
          </Column>
        );

      case 'operacion':
        // "Ticket promedio" y "Comprobantes del mes" usan SOLO comprobantes
        // estado='verificado' (la API ya excluye pendientes/rechazados).
        return (
          <Column title={w.label} icon="⚡">
            <MetricCard label="Tiempo 1ra respuesta"        value={mins(s.avgFirstHumanResponseMin)}                  href="/conversaciones" />
            <MetricCard label="Ticket promedio del mes"     value={money(s.ticketPromedio)}                          href="/cargas" />
            <MetricCard label="Ticket promedio mes anterior" value={money(s.ticketPromedioMesAnterior)}              href="/cargas" />
            <MetricCard label="Comprobantes del mes"        value={fmt(s.recargasMes)}                               href="/cargas" />
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
  const heroWidgets   = visible.filter((w) => widgetGroup(w) === 'hero');
  const metricWidgets = visible.filter((w) => widgetGroup(w) === 'metric');
  const chartWidgets  = visible.filter((w) => widgetGroup(w) === 'chart');

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

      {/* MÉTRICAS: 5 columnas desktop (≥1280) / 3 tablet / 1 mobile */}
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
