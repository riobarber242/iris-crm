"use client";

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import Link from 'next/link';

type TopClient = {
  contact_id:      string;
  cargas_total:    number;
  cargas_monto:    number;
  pagos_total:     number;
  pagos_monto:     number;
  // Alias de cargas (compat con el backend); el ranking es por cargas.
  total:           number;
  monto_total:     number;
  phone:           string;
  casino_username: string | null;
  status:          string;
};

type Period = 'hoy' | 'semana' | 'mes' | 'anio' | 'custom';

const PERIODS: { key: Period; label: string }[] = [
  { key: 'hoy',    label: 'Hoy' },
  { key: 'semana', label: 'Esta semana' },
  { key: 'mes',    label: 'Este mes' },
  { key: 'anio',   label: 'Este año' },
  { key: 'custom', label: 'Personalizado' },
];

const STATUS_STYLE: Record<string, React.CSSProperties> = {
  cliente_activo: { background: '#C8FF00', color: '#000' },
  inactivo:       { background: '#888',    color: '#fff' },
  nuevo:          { background: '#F0F0F0', color: '#888' },
};

// El layout del ranking (grid de columnas / card apilada según breakpoint) vive
// en globals.css: .leads-row + clases de celda (.leads-c-*, .leads-col-*).
//   Desktop >1024px : 7 columnas completas.
//   Tablet 640–1024 : posición | nombre | cargas | pagos | chat.
//   Mobile <640px   : card apilada (grid-areas), sin columnas.

// Rango [from, to] en ISO para un período relativo. `custom` se maneja aparte.
function rangeFor(period: Exclude<Period, 'custom'>): { from: string; to: string } {
  const now = new Date();
  const to  = now;
  let from: Date;
  if (period === 'hoy') {
    from = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  } else if (period === 'semana') {
    const day  = now.getDay();              // 0 dom … 6 sáb
    const diff = day === 0 ? 6 : day - 1;   // días desde el lunes
    from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diff, 0, 0, 0);
  } else if (period === 'mes') {
    from = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0);
  } else { // anio
    from = new Date(now.getFullYear(), 0, 1, 0, 0, 0);
  }
  return { from: from.toISOString(), to: to.toISOString() };
}

// Escapa una celda para CSV (comillas, comas, saltos de línea).
function csvCell(v: string | number): string {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export default function LeadsClient() {
  const [period,    setPeriod]    = useState<Period>('mes'); // por defecto: este mes
  const [customFrom, setCustomFrom] = useState('');          // YYYY-MM-DD
  const [customTo,   setCustomTo]   = useState('');
  const [minAmount, setMinAmount]  = useState(0);
  const [maxAmount, setMaxAmount]  = useState(0); // 0 = sin límite superior
  const [sortBy,    setSortBy]     = useState<'monto' | 'cantidad'>('monto');
  const [clients,   setClients]    = useState<TopClient[]>([]);
  const [loading,   setLoading]    = useState(true);
  const [error,     setError]      = useState(false);

  // Panel de filtros colapsable (mismo patrón que Conversaciones).
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filtersRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!filtersOpen) return;
    function onClickOutside(e: MouseEvent) {
      if (filtersRef.current && !filtersRef.current.contains(e.target as Node)) setFiltersOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [filtersOpen]);

  const fetchClients = useCallback(async () => {
    let from = '', to = '';
    if (period === 'custom') {
      if (!customFrom || !customTo) { setClients([]); setLoading(false); return; }
      from = new Date(`${customFrom}T00:00:00`).toISOString();
      to   = new Date(`${customTo}T23:59:59`).toISOString();
    } else {
      ({ from, to } = rangeFor(period));
    }
    setLoading(true);
    setError(false);
    try {
      const res = await fetch(`/api/leads?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
      if (!res.ok) { setError(true); setClients([]); return; }
      setClients(await res.json());
    } catch {
      setError(true);
      setClients([]);
    } finally {
      setLoading(false);
    }
  }, [period, customFrom, customTo]);

  useEffect(() => { fetchClients(); }, [fetchClients]);

  // Filtro de rango de monto CARGADO (en tiempo real, sobre lo ya traído).
  // maxAmount = 0 significa "sin límite superior".
  const filtered = useMemo(
    () => clients.filter((c) => c.cargas_monto >= minAmount && (maxAmount <= 0 || c.cargas_monto <= maxAmount)),
    [clients, minAmount, maxAmount],
  );

  // Ranking SOLO por cargas (los pagos nunca influyen). El toggle elige entre
  // monto cargado y cantidad de cargas. Las medallas siguen este orden.
  const ranked = useMemo(() => {
    const arr = [...filtered];
    arr.sort((a, b) => sortBy === 'cantidad'
      ? (b.cargas_total - a.cargas_total || b.cargas_monto - a.cargas_monto)
      : (b.cargas_monto - a.cargas_monto || b.cargas_total - a.cargas_total));
    return arr;
  }, [filtered, sortBy]);

  const totalCargado = filtered.reduce((s, c) => s + c.cargas_monto, 0);
  const totalPagado  = filtered.reduce((s, c) => s + c.pagos_monto, 0);

  // Filtros activos (para el badge del botón): período distinto del default + montos.
  const activeFilterCount = (period !== 'mes' ? 1 : 0) + (minAmount > 0 ? 1 : 0) + (maxAmount > 0 ? 1 : 0);
  const periodLabel = PERIODS.find((p) => p.key === period)?.label ?? '';

  function exportCSV() {
    const header = ['Posición', 'Nombre', 'Teléfono', 'Monto cargado', 'Cantidad de cargas', 'Monto pagado', 'Cantidad de pagos'];
    const rows = ranked.map((c, i) => [
      i + 1,
      c.casino_username || c.phone,
      c.phone,
      c.cargas_monto,
      c.cargas_total,
      c.pagos_monto,
      c.pagos_total,
    ]);
    const csv = [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n');
    // BOM para que Excel respete el UTF-8 (acentos).
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `top-clientes-${period}-${stamp}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  const pillStyle = (active: boolean): React.CSSProperties => ({
    background:   active ? '#1a1a1a' : '#F0F0F0',
    color:        active ? '#C8FF00' : '#666',
    border:       'none',
    borderRadius: '999px',
    padding:      '7px 16px',
    fontSize:     '13px',
    fontWeight:   700,
    cursor:       'pointer',
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

      {/* Barra: botón Filtros colapsable (período + rango de monto + orden) + exportar.
          Mismo patrón que el panel de filtros de Conversaciones. */}
      <div ref={filtersRef} style={{ position: 'relative', display: 'flex', gap: '8px', alignItems: 'center', justifyContent: 'space-between' }}>
        <button
          onClick={() => setFiltersOpen((o) => !o)}
          style={{
            display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0,
            padding: '11px 16px', fontSize: '14px', fontWeight: 700, cursor: 'pointer',
            borderRadius: '12px',
            border: activeFilterCount > 0 ? '2px solid #F97316' : '2px solid #e0e0e0',
            background: activeFilterCount > 0 ? '#F97316' : '#fff',
            color: activeFilterCount > 0 ? '#fff' : '#555',
            transition: 'background 0.15s, color 0.15s, border-color 0.15s',
          }}
        >
          {/* Ícono de embudo */}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
          </svg>
          Filtros
          {activeFilterCount > 0 && (
            <span style={{
              background: '#fff', color: '#F97316', borderRadius: '999px',
              fontSize: '11px', fontWeight: 800, minWidth: '18px', height: '18px',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '0 5px',
            }}>
              {activeFilterCount}
            </span>
          )}
        </button>

        <button
          onClick={exportCSV}
          disabled={ranked.length === 0}
          style={{
            background: ranked.length === 0 ? '#e0e0e0' : '#1a1a1a',
            color:      ranked.length === 0 ? '#999' : '#C8FF00',
            border: 'none', borderRadius: '12px', padding: '11px 18px',
            fontSize: '13px', fontWeight: 700, whiteSpace: 'nowrap',
            cursor: ranked.length === 0 ? 'not-allowed' : 'pointer',
          }}
        >
          ⬇ Exportar CSV
        </button>

        {/* Panel desplegable: full width en mobile, 360px alineado a la izquierda en desktop */}
        {filtersOpen && (
          <div
            style={{
              position: 'absolute', top: 'calc(100% + 8px)', left: 0, right: 0,
              maxWidth: '360px', marginRight: 'auto',
              background: '#fff', border: '2px solid #e0e0e0', borderRadius: '14px',
              boxShadow: '0 8px 28px rgba(0,0,0,0.12)', padding: '14px', zIndex: 20,
              display: 'flex', flexDirection: 'column', gap: '14px',
            }}
          >
            {/* Período */}
            <div>
              <p style={{ fontSize: '11px', fontWeight: 700, color: '#999', margin: '0 0 8px 0', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Período</p>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                {PERIODS.map((p) => (
                  <button
                    key={p.key}
                    onClick={() => { setPeriod(p.key); if (p.key !== 'custom') setFiltersOpen(false); }}
                    style={pillStyle(period === p.key)}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            {period === 'custom' && (
              <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '11px', fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Desde
                  <input type="date" value={customFrom} max={customTo || undefined} onChange={(e) => setCustomFrom(e.target.value)} style={inputStyle} />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '11px', fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Hasta
                  <input type="date" value={customTo} min={customFrom || undefined} onChange={(e) => setCustomTo(e.target.value)} style={inputStyle} />
                </label>
              </div>
            )}

            {/* Rango de monto (0/vacío = sin límite) */}
            <div>
              <p style={{ fontSize: '11px', fontWeight: 700, color: '#999', margin: '0 0 8px 0', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Rango de monto</p>
              <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span style={{ fontSize: '15px', fontWeight: 800, color: '#666' }}>$</span>
                  <input
                    type="number" min={0} step={1000} value={minAmount || ''} placeholder="Mínimo"
                    onChange={(e) => setMinAmount(Math.max(0, Number(e.target.value) || 0))}
                    style={{ ...inputStyle, width: '110px' }}
                  />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span style={{ fontSize: '15px', fontWeight: 800, color: '#666' }}>$</span>
                  <input
                    type="number" min={0} step={1000} value={maxAmount || ''} placeholder="Máximo"
                    onChange={(e) => setMaxAmount(Math.max(0, Number(e.target.value) || 0))}
                    style={{ ...inputStyle, width: '110px' }}
                  />
                </div>
              </div>
            </div>

            {/* Ordenar por */}
            <div>
              <p style={{ fontSize: '11px', fontWeight: 700, color: '#999', margin: '0 0 8px 0', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Ordenar por</p>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                {([['monto', 'Monto cargado'], ['cantidad', 'Cantidad de cargas']] as const).map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => { setSortBy(key); setFiltersOpen(false); }}
                    style={pillStyle(sortBy === key)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Summary cards (reflejan el filtro activo). En mobile se apilan (CSS). */}
      <div className="leads-cards" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px' }}>
        {[
          { label: 'Clientes',     value: filtered.length },
          { label: 'Total cargado', value: `$${totalCargado.toLocaleString('es-AR')}` },
          { label: 'Total pagado',  value: `$${totalPagado.toLocaleString('es-AR')}` },
        ].map((card) => (
          <div key={card.label} style={{ background: '#fff', borderRadius: '14px', padding: '16px 18px', boxShadow: '0 1px 8px rgba(0,0,0,0.06)' }}>
            <p style={{ fontSize: '11px', fontWeight: 700, color: '#aaa', textTransform: 'uppercase', letterSpacing: '0.08em', margin: 0 }}>
              {card.label}
            </p>
            <p style={{ fontSize: '28px', fontWeight: 900, color: '#000', margin: '6px 0 0 0', lineHeight: 1 }}>
              {card.value}
            </p>
          </div>
        ))}
      </div>

      {/* Ranking */}
      <div style={{ background: '#fff', borderRadius: '16px', padding: '18px', boxShadow: '0 1px 8px rgba(0,0,0,0.06)' }}>
        <h2 style={{ fontSize: '16px', fontWeight: 800, color: '#000', margin: '0 0 4px 0' }}>Ranking de clientes</h2>
        <p style={{ fontSize: '12px', color: '#999', margin: '0 0 16px 0' }}>
          {sortBy === 'cantidad' ? 'Por cantidad de cargas verificadas' : 'Por monto total cargado'} — {periodLabel}.
        </p>

        {loading ? (
          <p style={{ color: '#999', fontSize: '14px', textAlign: 'center', padding: '24px 0' }}>Cargando…</p>
        ) : error ? (
          <div style={{ textAlign: 'center', padding: '24px 0' }}>
            <p style={{ color: '#c0392b', fontSize: '14px', margin: '0 0 8px 0' }}>No se pudo cargar el ranking.</p>
            <button onClick={fetchClients} style={{ background: '#1a1a1a', color: '#C8FF00', border: 'none', borderRadius: '8px', padding: '6px 14px', fontSize: '13px', fontWeight: 700, cursor: 'pointer' }}>Reintentar</button>
          </div>
        ) : ranked.length === 0 ? (
          <p style={{ color: '#999', fontSize: '14px', textAlign: 'center', padding: '24px 0' }}>
            {clients.length === 0
              ? 'No hay cargas verificadas en este período.'
              : maxAmount > 0
                ? `Ningún cliente está entre $${minAmount.toLocaleString('es-AR')} y $${maxAmount.toLocaleString('es-AR')} en este período.`
                : `Ningún cliente supera $${minAmount.toLocaleString('es-AR')} en este período.`}
          </p>
        ) : (
          /* Layout responsive en globals.css (.leads-row + clases de celda):
             desktop 7 cols · tablet 5 cols (sin tel/estado) · mobile card. */
          <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
          <div className="leads-table" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {/* Header (oculto en mobile, donde cada fila es una card) */}
            <div className="leads-row leads-header" style={{ padding: '6px 14px', fontSize: '11px', fontWeight: 700, color: '#aaa', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              <span>#</span>
              <span>Usuario</span>
              <span className="leads-col-tel">Teléfono</span>
              <span className="leads-col-estado">Estado</span>
              <span>Cargas</span>
              <span>Pagos</span>
              <span />
            </div>

            {ranked.map((c, i) => {
              const st     = STATUS_STYLE[c.status] ?? STATUS_STYLE.nuevo;
              const medal  = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : null;
              const isTop1 = i === 0;
              return (
                <div key={c.contact_id} className="leads-row" style={{
                  background: isTop1 ? '#fff6da' : '#fff',
                  borderRadius: '14px', padding: '12px 14px',
                  boxShadow: '0 1px 6px rgba(0,0,0,0.06)',
                  border: isTop1 ? '1px solid #f0c040' : '1px solid #f0f0f0',
                }}>
                  <span className="leads-c-pos" style={{
                    fontSize: medal ? '20px' : '14px',
                    fontWeight: 900,
                    color: i < 3 ? '#b8860b' : '#bbb',
                    textAlign: 'center',
                  }}>
                    {medal ?? `#${i + 1}`}
                  </span>
                  <p className="leads-c-name" style={{ margin: 0, fontSize: '14px', fontWeight: 700, color: '#000', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {c.casino_username ? `🎰 ${c.casino_username}` : c.phone}
                  </p>
                  <p className="leads-col-tel" style={{ margin: 0, fontSize: '13px', color: '#888' }}>{c.phone}</p>
                  <span className="leads-col-estado" style={{ ...st, fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.02em', borderRadius: '999px', padding: '3px 8px', display: 'inline-block', textAlign: 'center', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }}>
                    {c.status}
                  </span>
                  {/* Cargas: métrica principal del ranking. */}
                  <div className="leads-c-cargas">
                    <p style={{ margin: 0, fontSize: '15px', fontWeight: 900, color: '#000' }}>
                      ${c.cargas_monto.toLocaleString('es-AR')}
                    </p>
                    <p style={{ margin: '2px 0 0 0', fontSize: '11px', fontWeight: 700, color: '#999' }}>
                      {c.cargas_total} {c.cargas_total === 1 ? 'carga' : 'cargas'}
                    </p>
                  </div>
                  {/* Pagos: informativo, no influye en el orden. */}
                  <div className="leads-c-pagos">
                    <p style={{ margin: 0, fontSize: '15px', fontWeight: 800, color: c.pagos_monto > 0 ? '#1a7a3a' : '#bbb' }}>
                      ${c.pagos_monto.toLocaleString('es-AR')}
                    </p>
                    <p style={{ margin: '2px 0 0 0', fontSize: '11px', fontWeight: 700, color: '#999' }}>
                      {c.pagos_total} {c.pagos_total === 1 ? 'pago' : 'pagos'}
                    </p>
                  </div>
                  <Link className="leads-c-chat" href={`/conversaciones/${c.contact_id}`} style={{ textDecoration: 'none' }}>
                    <div style={{ width: '32px', height: '32px', borderRadius: '8px', background: '#1a1a1a', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '15px', cursor: 'pointer' }} title="Ir a conversación">
                      💬
                    </div>
                  </Link>
                </div>
              );
            })}
          </div>
          </div>
        )}
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  background: '#F5F5F5', border: '2px solid #eee', borderRadius: '10px',
  padding: '8px 12px', fontSize: '14px', color: '#1a1a1a', outline: 'none',
};
