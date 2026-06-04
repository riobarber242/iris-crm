"use client";

import React, { useEffect, useState } from 'react';

type StatusItem    = { status: string; label: string; count: number; color: string };
type EstadoItem    = { estado: string; label: string; count: number; color: string };
type MonthItem     = { label: string; monto: number };
type ProvinceItem  = { provincia: string; total: number; dominant: string };

type ChartsData = {
  contactsByStatus:     StatusItem[];
  comprobantesByEstado: EstadoItem[];
  revenueByMonth:       MonthItem[];
  provinceData:         ProvinceItem[];
};

// Province center coordinates in the Argentina SVG (viewBox "0 0 280 480")
const PROVINCE_COORDS: Record<string, [number, number]> = {
  'Jujuy':                  [116,  23],
  'Salta':                  [130,  43],
  'Formosa':                [195,  20],
  'Chaco':                  [205,  68],
  'Misiones':               [260,  72],
  'Tucumán':                [138,  72],
  'Santiago del Estero':    [168,  88],
  'Corrientes':             [225,  92],
  'Catamarca':              [ 96,  88],
  'La Rioja':               [ 94, 114],
  'Córdoba':                [150, 140],
  'Santa Fe':               [196, 138],
  'Entre Ríos':             [228, 148],
  'San Juan':               [ 72, 132],
  'San Luis':               [112, 168],
  'La Pampa':               [148, 216],
  'Mendoza':                [ 62, 164],
  'CABA':                   [228, 192],
  'Buenos Aires':           [210, 225],
  'Neuquén':                [ 78, 252],
  'Río Negro':              [ 98, 282],
  'Chubut':                 [120, 318],
  'Santa Cruz':             [ 72, 400],
  'Tierra del Fuego':       [ 80, 462],
};

const STATUS_COLOR: Record<string, string> = {
  cliente_activo: '#C8FF00',
  nuevo:          '#4A90D9',
  inactivo:       '#aaa',
  bloqueado:      '#FF4444',
  en_proceso:     '#FFB800',
};

// ── SVG Donut ──────────────────────────────────────────────────────────────────
const R  = 58;
const CX = 80;
const CY = 80;
const C  = 2 * Math.PI * R; // circumference ≈ 364.4

function DonutChart({
  data, title, emptyLabel = 'Sin datos',
}: {
  data: { label: string; value: number; color: string }[];
  title: string;
  emptyLabel?: string;
}) {
  const total = data.reduce((s, d) => s + d.value, 0);
  let offset = 0;
  const segments = data.map((d) => {
    const dash = total > 0 ? (d.value / total) * C : 0;
    const seg  = { ...d, dash, offset };
    offset += dash;
    return seg;
  });

  return (
    <div className="dash-chart" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '14px', flex: 1, minWidth: '220px' }}>
      <p style={{ fontSize: '13px', fontWeight: 700, color: '#555', textTransform: 'uppercase', letterSpacing: '0.08em', margin: 0 }}>{title}</p>

      <svg width="160" height="160" viewBox="0 0 160 160">
        {total === 0 ? (
          <>
            <circle cx={CX} cy={CY} r={R} fill="none" stroke="#F0F0F0" strokeWidth="22" />
            <text x={CX} y={CY} textAnchor="middle" dominantBaseline="middle" fontSize="12" fill="#ccc">{emptyLabel}</text>
          </>
        ) : (
          <>
            <g transform={`rotate(-90 ${CX} ${CY})`}>
              {segments.map((seg, i) => (
                <circle
                  key={i}
                  cx={CX} cy={CY} r={R}
                  fill="none"
                  stroke={seg.color}
                  strokeWidth="22"
                  strokeLinecap="butt"
                  strokeDasharray={`${seg.dash} ${C - seg.dash}`}
                  strokeDashoffset={-seg.offset}
                />
              ))}
            </g>
            <text x={CX} y={CY - 8}  textAnchor="middle" dominantBaseline="middle" fontSize="26" fontWeight="900" fill="#000">{total}</text>
            <text x={CX} y={CY + 16} textAnchor="middle" dominantBaseline="middle" fontSize="11" fill="#aaa">total</text>
          </>
        )}
      </svg>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', width: '100%', maxWidth: '200px' }}>
        {data.map((d) => (
          <div key={d.label} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{ width: '10px', height: '10px', borderRadius: '3px', background: d.color, flexShrink: 0 }} />
            <span style={{ fontSize: '13px', color: '#555', flex: 1 }}>{d.label}</span>
            <span style={{ fontSize: '13px', fontWeight: 800, color: '#000' }}>{d.value}</span>
            {total > 0 && (
              <span style={{ fontSize: '11px', color: '#aaa', minWidth: '34px', textAlign: 'right' }}>
                {Math.round((d.value / total) * 100)}%
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── SVG Bar chart ──────────────────────────────────────────────────────────────
function BarChart({ data, title }: { data: MonthItem[]; title: string }) {
  const max    = Math.max(...data.map((d) => d.monto), 1);
  const W      = 420;
  const H      = 140;
  const PAD    = 32;
  const barW   = Math.floor((W - PAD * 2) / data.length) - 6;
  const barArea = H - 32; // reserve 32px for labels at bottom

  function fmt(n: number) {
    if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000)     return `$${Math.round(n / 1_000)}k`;
    return `$${n}`;
  }

  return (
    <div className="dash-chart" style={{ display: 'flex', flexDirection: 'column', gap: '14px', flex: 2, minWidth: '320px' }}>
      <p style={{ fontSize: '13px', fontWeight: 700, color: '#555', textTransform: 'uppercase', letterSpacing: '0.08em', margin: 0 }}>{title}</p>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ overflow: 'visible' }}>
        {/* Zero line */}
        <line x1={PAD} y1={barArea} x2={W - PAD} y2={barArea} stroke="#e0e0e0" strokeWidth="1" />

        {data.map((d, i) => {
          const barH  = max > 0 ? (d.monto / max) * (barArea - 8) : 0;
          const x     = PAD + i * ((W - PAD * 2) / data.length) + 3;
          const y     = barArea - barH;
          const isMax = d.monto === max && max > 0;

          return (
            <g key={i}>
              <rect
                x={x} y={y} width={barW} height={barH}
                rx="5" ry="5"
                fill={isMax ? '#C8FF00' : '#1a1a1a'}
              />
              {d.monto > 0 && (
                <text
                  x={x + barW / 2} y={y - 5}
                  textAnchor="middle" fontSize="10" fontWeight="700"
                  fill={isMax ? '#4a7000' : '#555'}
                >
                  {fmt(d.monto)}
                </text>
              )}
              <text
                x={x + barW / 2} y={barArea + 18}
                textAnchor="middle" fontSize="12" fill="#aaa" fontWeight="600"
              >
                {d.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ── Argentina Map ─────────────────────────────────────────────────────────────
// Simplified outline path. ViewBox: 0 0 280 480
const ARG_PATH =
  'M 64,3 L 215,3 L 265,68 L 248,105 L 225,148 L 235,192 L 225,238 ' +
  'L 175,252 L 155,265 L 145,282 L 158,292 L 142,305 L 122,325 ' +
  'L 112,352 L 95,388 L 72,435 L 85,452 L 100,468 L 82,478 ' +
  'L 52,472 L 32,452 L 5,432 L 5,395 L 8,345 L 15,278 ' +
  'L 22,235 L 34,165 L 46,108 L 55,52 L 64,3 Z';

function ArgentinaMap({ data }: { data: ProvinceItem[] }) {
  const byProvincia = new Map(data.map((d) => [d.provincia, d]));
  const hasData     = data.length > 0;

  return (
    <div className="dash-chart" style={{ display: 'flex', flexDirection: 'column', gap: '14px', flex: 1, minWidth: '260px' }}>
      <p style={{ fontSize: '13px', fontWeight: 700, color: '#555', textTransform: 'uppercase', letterSpacing: '0.08em', margin: 0 }}>
        Distribución por provincia
      </p>

      <div style={{ display: 'flex', gap: '20px', alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <svg width="160" viewBox="0 0 280 480" style={{ flexShrink: 0, overflow: 'visible' }}>
          {/* Argentina outline */}
          <path d={ARG_PATH} fill="#F5F5F5" stroke="#ddd" strokeWidth="2" strokeLinejoin="round" />

          {/* Province dots */}
          {Object.entries(PROVINCE_COORDS).map(([prov, [cx, cy]]) => {
            const item   = byProvincia.get(prov);
            const color  = item ? (STATUS_COLOR[item.dominant] ?? '#4A90D9') : '#e0e0e0';
            const r      = item ? Math.min(18, Math.max(7, Math.sqrt(item.total) * 2.5)) : 4;
            const stroke = item ? (item.dominant === 'cliente_activo' ? '#8ab000' : 'rgba(0,0,0,0.15)') : '#ccc';
            return (
              <g key={prov}>
                <circle cx={cx} cy={cy} r={r} fill={color} stroke={stroke} strokeWidth="1.5" opacity={item ? 1 : 0.4} />
                {item && (
                  <text x={cx} y={cy + 1} textAnchor="middle" dominantBaseline="middle" fontSize="8" fontWeight="800" fill={item.dominant === 'cliente_activo' ? '#3a5a00' : '#fff'}>
                    {item.total}
                  </text>
                )}
              </g>
            );
          })}
        </svg>

        {/* Legend + ranked list */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', flex: 1 }}>
          {!hasData ? (
            <p style={{ fontSize: '12px', color: '#bbb', margin: 0 }}>
              Asigná provincia en cada contacto para ver el mapa.
            </p>
          ) : (
            [...data].sort((a, b) => b.total - a.total).slice(0, 8).map((d) => (
              <div key={d.provincia} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: STATUS_COLOR[d.dominant] ?? '#4A90D9', flexShrink: 0 }} />
                <span style={{ fontSize: '12px', color: '#555', flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.provincia}</span>
                <span style={{ fontSize: '12px', fontWeight: 800, color: '#000' }}>{d.total}</span>
              </div>
            ))
          )}
          <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {Object.entries({ 'Cliente activo': '#C8FF00', 'Nuevo': '#4A90D9', 'Inactivo': '#aaa', 'Bloqueado': '#FF4444' }).map(([label, color]) => (
              <div key={label} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <div style={{ width: '8px', height: '8px', borderRadius: '2px', background: color, flexShrink: 0 }} />
                <span style={{ fontSize: '11px', color: '#999' }}>{label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Main export ────────────────────────────────────────────────────────────────
export default function DashboardCharts() {
  const [data, setData]       = useState<ChartsData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/dashboard_charts')
      .then((r) => r.json())
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div style={{ background: '#F0F0F0', borderRadius: '20px', height: '280px', marginTop: '8px' }} />
    );
  }

  if (!data) return null;

  const contactData     = data.contactsByStatus.map((d)    => ({ label: d.label, value: d.count, color: d.color }));
  const comprobanteData = data.comprobantesByEstado.map((d) => ({ label: d.label, value: d.count, color: d.color }));

  const twoMonths = data.revenueByMonth.slice(-2);

  return (
    <div className="dash-charts" style={{ background: '#fff', borderRadius: '20px', padding: '24px', boxShadow: '0 2px 16px rgba(0,0,0,0.07)', marginTop: '8px', display: 'flex', gap: '32px', flexWrap: 'wrap', alignItems: 'flex-start' }}>
      <DonutChart data={contactData}     title="Estado de contactos"  emptyLabel="Sin contactos" />
      <DonutChart data={comprobanteData} title="Comprobantes"         emptyLabel="Sin comprobantes" />
      <ArgentinaMap data={data.provinceData ?? []} />
      <BarChart   data={twoMonths} title="Mes anterior vs actual" />
    </div>
  );
}
