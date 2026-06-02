"use client";

import React, { useEffect, useState } from 'react';

type StatusItem  = { status: string;  label: string; count: number; color: string };
type EstadoItem  = { estado: string;  label: string; count: number; color: string };
type MonthItem   = { label: string; monto: number };

type ChartsData = {
  contactsByStatus:    StatusItem[];
  comprobantesByEstado: EstadoItem[];
  revenueByMonth:      MonthItem[];
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
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '14px', flex: 1, minWidth: '220px' }}>
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', flex: 2, minWidth: '320px' }}>
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
      <div style={{ display: 'flex', gap: '16px', marginTop: '8px' }}>
        {[0, 1, 2].map((i) => (
          <div key={i} style={{ flex: i < 2 ? 1 : 2, background: '#F0F0F0', borderRadius: '20px', height: '280px' }} />
        ))}
      </div>
    );
  }

  if (!data) return null;

  const contactData    = data.contactsByStatus.map((d)    => ({ label: d.label, value: d.count, color: d.color }));
  const comprobanteData = data.comprobantesByEstado.map((d) => ({ label: d.label, value: d.count, color: d.color }));

  return (
    <div
      style={{
        background: '#fff',
        borderRadius: '20px',
        padding: '24px',
        boxShadow: '0 2px 16px rgba(0,0,0,0.07)',
        marginTop: '8px',
        display: 'flex',
        gap: '32px',
        flexWrap: 'wrap',
        alignItems: 'flex-start',
      }}
    >
      <DonutChart data={contactData}     title="Estado de contactos" emptyLabel="Sin contactos" />
      <DonutChart data={comprobanteData} title="Comprobantes"        emptyLabel="Sin comprobantes" />
      <BarChart   data={data.revenueByMonth} title="Ingresos últimos 6 meses" />
    </div>
  );
}
