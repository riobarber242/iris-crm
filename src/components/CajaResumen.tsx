'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';

// ─────────────────────────────────────────────────────────────────────────────
// Banda de caja en el dashboard (solo admin/agent — el dashboard ya es staff).
// Muestra el stock del pozo, el total de billeteras y el desglose por operador.
// Se oculta si la caja no está en uso (sin migración, o apagada y sin datos),
// para no ensuciar el dashboard de quien no usa el sistema de fichas.
// ─────────────────────────────────────────────────────────────────────────────

type Billetera = { operador_id: string; name: string; role: string | null; saldo: number };
type Resumen = {
  caja_enabled: boolean; degraded?: boolean; stock: number; total_billeteras: number; billeteras: Billetera[];
};

const fmt = (n: number) => n.toLocaleString('es-AR');

function Card({ label, value, sub, dark }: { label: string; value: string; sub?: string; dark?: boolean }) {
  return (
    <div style={{
      background: dark ? '#0a0a0a' : '#FFFFFF', borderRadius: '16px', padding: '16px 18px',
      boxShadow: '0 2px 10px rgba(0,0,0,0.07)', flex: 1, minWidth: '180px',
    }}>
      <p style={{ margin: 0, fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: dark ? '#aaff00' : '#999' }}>
        {label}
      </p>
      <p style={{ margin: '6px 0 0', fontSize: '30px', fontWeight: 900, color: dark ? '#fff' : '#000', lineHeight: 1 }}>
        {value}
      </p>
      {sub && <p style={{ margin: '6px 0 0', fontSize: '12px', color: dark ? '#888' : '#aaa' }}>{sub}</p>}
    </div>
  );
}

export default function CajaResumen() {
  const [data, setData] = useState<Resumen | null>(null);

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const res = await fetch('/api/fichas');
        if (!res.ok) return;
        const d = await res.json();
        if (alive) setData(d);
      } catch {}
    }
    load();
    const t = setInterval(load, 15_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  // No mostramos nada hasta tener datos, ni si la caja no está en uso.
  if (!data || data.degraded) return null;
  const enUso = data.caja_enabled || data.stock > 0 || data.billeteras.length > 0;
  if (!enUso) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '16px' }}>🎰</span>
          <h3 style={{ fontSize: '13px', fontWeight: 700, color: '#1a1a1a', margin: 0, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Caja de fichas
          </h3>
          <span style={{
            fontSize: '10px', fontWeight: 800, padding: '2px 8px', borderRadius: '999px',
            background: data.caja_enabled ? '#e8fff0' : '#f0f0f0', color: data.caja_enabled ? '#1a7a3a' : '#999',
          }}>
            {data.caja_enabled ? 'ACTIVA' : 'APAGADA'}
          </span>
        </div>
        <Link href="/fichas" style={{ fontSize: '12px', fontWeight: 700, color: '#1d6fb8', textDecoration: 'none' }}>
          Ir a Fichas →
        </Link>
      </div>

      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
        <Card label="Stock del pozo" value={fmt(data.stock)} sub="fichas disponibles" dark />
        <Card label="Total billeteras" value={fmt(data.total_billeteras)} sub={`${data.billeteras.length} operador${data.billeteras.length === 1 ? '' : 'es'}`} />
      </div>

      {/* Desglose por operador */}
      {data.billeteras.length > 0 && (
        <div style={{ background: '#fff', borderRadius: '16px', padding: '14px 16px', boxShadow: '0 2px 10px rgba(0,0,0,0.06)', display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <p style={{ margin: '0 0 4px', fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#aaa' }}>
            Billeteras por operador
          </p>
          {data.billeteras.map((b) => (
            <div key={b.operador_id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', padding: '6px 0', borderBottom: '1px solid #f3f3f3' }}>
              <span style={{ fontSize: '13px', fontWeight: 600, color: '#333', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {b.name}
                {b.role && b.role !== 'operator' && (
                  <span style={{ fontSize: '10px', fontWeight: 700, color: '#aaa', marginLeft: '6px', textTransform: 'uppercase' }}>{b.role}</span>
                )}
              </span>
              <span style={{ fontSize: '14px', fontWeight: 800, color: b.saldo < 0 ? '#c0392b' : '#111' }}>
                {fmt(b.saldo)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
