"use client";

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import Link from 'next/link';

type TopClient = {
  contact_id:      string;
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

const GRID = '46px 1fr 1fr 90px 100px 100px 36px';

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
  const [clients,   setClients]    = useState<TopClient[]>([]);
  const [loading,   setLoading]    = useState(true);
  const [error,     setError]      = useState(false);

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

  // Filtro de rango de monto (en tiempo real, sobre lo ya traído).
  // maxAmount = 0 significa "sin límite superior".
  const filtered = useMemo(
    () => clients.filter((c) => c.monto_total >= minAmount && (maxAmount <= 0 || c.monto_total <= maxAmount)),
    [clients, minAmount, maxAmount],
  );

  const totalMonto = filtered.reduce((s, c) => s + c.monto_total, 0);
  const totalComps = filtered.reduce((s, c) => s + c.total, 0);

  function exportCSV() {
    const header = ['Posición', 'Nombre', 'Teléfono', 'Total', 'Cantidad de comprobantes'];
    const rows = filtered.map((c, i) => [
      i + 1,
      c.casino_username || c.phone,
      c.phone,
      c.monto_total,
      c.total,
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

      {/* Controles: período + monto mínimo + exportar */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', background: '#fff', borderRadius: '16px', padding: '16px 18px', boxShadow: '0 1px 8px rgba(0,0,0,0.06)' }}>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          {PERIODS.map((p) => (
            <button key={p.key} onClick={() => setPeriod(p.key)} style={pillStyle(period === p.key)}>
              {p.label}
            </button>
          ))}
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

        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: 'space-between' }}>
          {/* Rango de monto: mínimo + máximo (0/vacío = sin límite). */}
          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '11px', fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Monto mínimo
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span style={{ fontSize: '15px', fontWeight: 800, color: '#666' }}>$</span>
                <input
                  type="number"
                  min={0}
                  step={1000}
                  value={minAmount || ''}
                  placeholder="0"
                  onChange={(e) => setMinAmount(Math.max(0, Number(e.target.value) || 0))}
                  style={{ ...inputStyle, width: '120px' }}
                />
              </div>
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '11px', fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Monto máximo
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span style={{ fontSize: '15px', fontWeight: 800, color: '#666' }}>$</span>
                <input
                  type="number"
                  min={0}
                  step={1000}
                  value={maxAmount || ''}
                  placeholder="Sin límite"
                  onChange={(e) => setMaxAmount(Math.max(0, Number(e.target.value) || 0))}
                  style={{ ...inputStyle, width: '120px' }}
                />
              </div>
            </label>
          </div>

          <button
            onClick={exportCSV}
            disabled={filtered.length === 0}
            style={{
              background: filtered.length === 0 ? '#e0e0e0' : '#1a1a1a',
              color:      filtered.length === 0 ? '#999' : '#C8FF00',
              border: 'none', borderRadius: '12px', padding: '11px 18px',
              fontSize: '13px', fontWeight: 700, whiteSpace: 'nowrap',
              cursor: filtered.length === 0 ? 'not-allowed' : 'pointer',
            }}
          >
            ⬇ Exportar CSV
          </button>
        </div>
      </div>

      {/* Summary cards (reflejan el filtro activo) */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px' }}>
        {[
          { label: 'Clientes con recargas', value: filtered.length },
          { label: 'Total comprobantes',    value: totalComps },
          { label: 'Monto total verificado', value: `$${totalMonto.toLocaleString('es-AR')}` },
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
        <p style={{ fontSize: '12px', color: '#999', margin: '0 0 16px 0' }}>Por monto total de recargas verificadas en el período.</p>

        {loading ? (
          <p style={{ color: '#999', fontSize: '14px', textAlign: 'center', padding: '24px 0' }}>Cargando…</p>
        ) : error ? (
          <div style={{ textAlign: 'center', padding: '24px 0' }}>
            <p style={{ color: '#c0392b', fontSize: '14px', margin: '0 0 8px 0' }}>No se pudo cargar el ranking.</p>
            <button onClick={fetchClients} style={{ background: '#1a1a1a', color: '#C8FF00', border: 'none', borderRadius: '8px', padding: '6px 14px', fontSize: '13px', fontWeight: 700, cursor: 'pointer' }}>Reintentar</button>
          </div>
        ) : filtered.length === 0 ? (
          <p style={{ color: '#999', fontSize: '14px', textAlign: 'center', padding: '24px 0' }}>
            {clients.length === 0
              ? 'No hay comprobantes verificados en este período.'
              : maxAmount > 0
                ? `Ningún cliente está entre $${minAmount.toLocaleString('es-AR')} y $${maxAmount.toLocaleString('es-AR')} en este período.`
                : `Ningún cliente supera $${minAmount.toLocaleString('es-AR')} en este período.`}
          </p>
        ) : (
          /* En mobile la tabla scrollea horizontal (minWidth interno); en
             desktop no cambia nada porque el contenedor ya es más ancho. */
          <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', minWidth: '640px' }}>
            {/* Header */}
            <div style={{ display: 'grid', gridTemplateColumns: GRID, gap: '12px', padding: '6px 14px', fontSize: '11px', fontWeight: 700, color: '#aaa', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              <span>#</span>
              <span>Usuario</span>
              <span>Teléfono</span>
              <span>Estado</span>
              <span style={{ textAlign: 'center' }}>Recargas</span>
              <span>Monto total</span>
              <span />
            </div>

            {filtered.map((c, i) => {
              const st     = STATUS_STYLE[c.status] ?? STATUS_STYLE.nuevo;
              const medal  = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : null;
              const isTop1 = i === 0;
              return (
                <div key={c.contact_id} style={{
                  display: 'grid', gridTemplateColumns: GRID, gap: '12px', alignItems: 'center',
                  background: isTop1 ? '#fff6da' : '#fff',
                  borderRadius: '14px', padding: '12px 14px',
                  boxShadow: '0 1px 6px rgba(0,0,0,0.06)',
                  border: isTop1 ? '1px solid #f0c040' : '1px solid #f0f0f0',
                }}>
                  <span style={{
                    fontSize: medal ? '20px' : '14px',
                    fontWeight: 900,
                    color: i < 3 ? '#b8860b' : '#bbb',
                    textAlign: 'center',
                  }}>
                    {medal ?? `#${i + 1}`}
                  </span>
                  <p style={{ margin: 0, fontSize: '14px', fontWeight: 700, color: '#000', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {c.casino_username ? `🎰 ${c.casino_username}` : c.phone}
                  </p>
                  <p style={{ margin: 0, fontSize: '13px', color: '#888' }}>{c.phone}</p>
                  <span style={{ ...st, fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', borderRadius: '999px', padding: '3px 10px', display: 'inline-block', textAlign: 'center' }}>
                    {c.status}
                  </span>
                  <p style={{ margin: 0, fontSize: '14px', fontWeight: 700, color: '#000', textAlign: 'center' }}>
                    {c.total} ✓
                  </p>
                  <p style={{ margin: 0, fontSize: '15px', fontWeight: 900, color: '#000' }}>
                    ${c.monto_total.toLocaleString('es-AR')}
                  </p>
                  <Link href={`/conversations/${c.contact_id}`} style={{ textDecoration: 'none' }}>
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
