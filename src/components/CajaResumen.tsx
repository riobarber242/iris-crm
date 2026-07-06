'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { getSupabaseBrowser } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';

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
  // tenant del usuario: filtra el postgres_changes de movimientos por tenant.
  const { agent } = useAuth();
  const tid = agent?.tenant_id ?? null;

  // Saldo de fichas del agente en el casino (admin.celuapuestas.bond). Solo se
  // muestra en tenants con casino_deposit_enabled=true (lo decide el backend).
  const [casinoEnabled, setCasinoEnabled] = useState(false);
  const [casinoBalance, setCasinoBalance] = useState<number | null>(null);

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
    // Saldo del casino: best-effort, gateado por tenant en el backend.
    async function fetchCasinoBalance() {
      try {
        const res = await fetch('/api/casino/balance');
        if (!res.ok) return;
        const j = await res.json();
        setCasinoEnabled(!!j.enabled);
        if (j.enabled && typeof j.balance === 'number') setCasinoBalance(j.balance);
      } catch {}
    }
    const refreshAll = () => { load(); fetchCasinoBalance(); };
    refreshAll();
    // Poll de respaldo relajado a 30 s: la inmediatez la da el Broadcast de Fase 2.
    const t = setInterval(refreshAll, 30_000);

    // Fase 2: señal de movimiento (via AdminShell) → refresca los saldos al instante.
    const onMov = () => refreshAll();
    window.addEventListener('iris:movimiento-broadcast', onMov);

    // postgres_changes de respaldo (dead bajo RLS para la anon key).
    const sb = getSupabaseBrowser();
    let ch: any = null;
    if (sb && tid) {
      ch = sb.channel('realtime-caja-resumen')
        .on('postgres_changes' as any, { event: 'INSERT', schema: 'public', table: 'movimientos', filter: `tenant_id=eq.${tid}` }, () => refreshAll())
        .subscribe();
    }

    return () => {
      alive = false;
      clearInterval(t);
      window.removeEventListener('iris:movimiento-broadcast', onMov);
      if (sb && ch) { try { sb.removeChannel(ch); } catch (err) { console.warn('[caja-resumen realtime] removeChannel falló:', err); } }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tid]);

  // No mostramos nada hasta tener datos, ni si la caja no está en uso.
  if (!data || data.degraded) return null;
  const enUso = data.caja_enabled || data.stock > 0 || data.billeteras.length > 0 || casinoEnabled;
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

      {/* Con casino activado mostramos el saldo del casino (sincronizado en vivo)
          en lugar del pozo interno; si no, las dos cards de siempre. */}
      {casinoEnabled ? (
        <div style={{ background: 'linear-gradient(135deg, #0b3d3a 0%, #16324f 55%, #2a1a5e 100%)', border: '1px solid #2f6f6a', borderRadius: '18px', padding: '22px 26px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' }}>
          <div>
            <p style={{ margin: 0, fontSize: '12px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#5fe3c8' }}>
              🎰 Saldo casino
            </p>
            <p style={{ margin: '6px 0 0', fontSize: '40px', fontWeight: 900, color: '#fff', lineHeight: 1 }}>
              {casinoBalance != null ? casinoBalance.toLocaleString('es-AR', { maximumFractionDigits: 2 }) : '—'}
            </p>
            <p style={{ margin: '6px 0 0', fontSize: '12px', color: '#9fb6c8' }}>
              fichas del agente en el casino · sincronizado en vivo
            </p>
          </div>
          <span style={{ fontSize: '11px', color: '#7fa0b8', maxWidth: '210px', textAlign: 'right', lineHeight: 1.4 }}>
            Baja al verificar una carga (le diste fichas a un jugador) y sube al verificar un pago.
          </span>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
          <Card label="Stock del pozo" value={fmt(data.stock)} sub="fichas disponibles" dark />
          <Card label="Total billeteras" value={fmt(data.total_billeteras)} sub={`${data.billeteras.length} operador${data.billeteras.length === 1 ? '' : 'es'}`} />
        </div>
      )}

      {/* Desglose por operador (cards compactas, solo lectura) */}
      {data.billeteras.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <p style={{ margin: '0 0 2px', fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#aaa' }}>
            Billeteras por operador
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
            {data.billeteras.map((b) => (
              <div key={b.operador_id} style={{
                flex: '1 1 calc(50% - 6px)', minWidth: '140px',
                background: '#fff', borderRadius: '14px', padding: '14px 16px',
                boxShadow: '0 1px 5px rgba(0,0,0,0.05)',
                display: 'flex', flexDirection: 'column', gap: '6px',
              }}>
                <span style={{ fontSize: '12px', fontWeight: 700, color: '#888', textTransform: 'uppercase' }}>
                  {b.name}
                  {b.role && b.role !== 'operator' && (
                    <span style={{ fontSize: '10px', fontWeight: 700, color: '#bbb', marginLeft: '6px' }}>{b.role}</span>
                  )}
                </span>
                <span style={{ fontSize: '26px', fontWeight: 900, color: b.saldo < 0 ? '#c0392b' : '#111', lineHeight: 1 }}>
                  {fmt(b.saldo)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
