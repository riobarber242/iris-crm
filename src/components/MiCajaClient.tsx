'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

// ─────────────────────────────────────────────────────────────────────────────
// Panel de caja del operador (Etapa 4b) — SOLO LECTURA.
// 4 cards clickeables sobre /api/caja/operador (scopeado al operador logueado):
//   1) Mi billetera     → mis movimientos con saldo corriendo (asc).
//   2) Pozo de fichas    → últimos movimientos del pozo (comunal, sin atribuir).
//   3) Mis movs de hoy   → mis movimientos de hoy; clic abre el comprobante.
//   4) Pendientes        → cola global; tocar uno lleva a Cargas/Pagos.
// Con la caja apagada: números en gris + cartel, sin botones de acción.
// ─────────────────────────────────────────────────────────────────────────────

const fmt = (n: number) => n.toLocaleString('es-AR');

function fechaCorta(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const fecha = d.toLocaleDateString('es-AR', { day: 'numeric', month: 'short' }).replace(/\.$/, '');
  const hora  = d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  return `${fecha} ${hora}`;
}

const TIPO_LABEL: Record<string, string> = {
  carga: 'Carga', pago: 'Pago', descarga: 'Descarga', sueldo: 'Sueldo', traspaso: 'Traspaso',
};

type Resumen = {
  caja_enabled: boolean; degraded?: boolean;
  mi_saldo: number; pozo: number; mov_hoy_count: number; pendientes_count: number;
};
type Vista = 'resumen' | 'billetera' | 'pozo' | 'hoy' | 'pendientes';

// ── Card ──────────────────────────────────────────────────────────────────────
function Card({ label, value, sub, dark, off, onClick, badge }: {
  label: string; value: string; sub?: string; dark?: boolean; off?: boolean;
  onClick: () => void; badge?: number;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        textAlign: 'left', cursor: 'pointer', border: 'none', position: 'relative',
        background: dark ? (off ? '#2a2a2a' : '#0a0a0a') : '#FFFFFF',
        borderRadius: '16px', padding: '16px 18px',
        boxShadow: '0 2px 10px rgba(0,0,0,0.07)', flex: 1, minWidth: '180px',
        opacity: off ? 0.85 : 1,
      }}
      className="nav-3d"
    >
      <p style={{ margin: 0, fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: dark ? '#aaff00' : '#999' }}>
        {label}
      </p>
      <p style={{ margin: '6px 0 0', fontSize: '30px', fontWeight: 900, lineHeight: 1, color: off ? '#9a9a9a' : (dark ? '#fff' : '#000') }}>
        {value}
      </p>
      {sub && <p style={{ margin: '6px 0 0', fontSize: '12px', color: dark ? '#888' : '#aaa' }}>{sub}</p>}
      {!!badge && badge > 0 && (
        <span style={{
          position: 'absolute', top: '12px', right: '12px',
          background: '#E53935', color: '#fff', borderRadius: '999px',
          fontSize: '11px', fontWeight: 800, minWidth: '20px', height: '20px',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '0 6px',
        }}>
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </button>
  );
}

function BackBar({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '14px' }}>
      <button onClick={onBack} style={{
        background: '#f0f0f0', border: 'none', borderRadius: '8px', padding: '6px 12px',
        fontSize: '13px', fontWeight: 700, color: '#555', cursor: 'pointer',
      }}>← Volver</button>
      <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 800, color: '#1a1a1a' }}>{title}</h3>
    </div>
  );
}

function Vacio({ texto }: { texto: string }) {
  return <p style={{ color: '#999', fontSize: '14px', padding: '14px 4px', margin: 0 }}>{texto}</p>;
}

// ── Modal de comprobante (lectura) ─────────────────────────────────────────────
type CompDetalle = {
  id: string; tipo: string; monto: number | null; bono: number | null; estado: string;
  image_url: string | null; created_at: string; resolved_by_name: string | null;
  resolved_at: string | null; contacto: string | null;
};

function ComprobanteModal({ id, onClose }: { id: string; onClose: () => void }) {
  const [data, setData] = useState<CompDetalle | null>(null);
  const [err, setErr]   = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/caja/operador?view=comprobante&id=${encodeURIComponent(id)}`)
      .then(async (r) => { if (!r.ok) throw new Error(await r.text()); return r.json(); })
      .then((d) => { if (alive) setData(d); })
      .catch(() => { if (alive) setErr('No se pudo abrir el comprobante.'); });
    return () => { alive = false; };
  }, [id]);

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: '16px', maxWidth: '440px', width: '100%', maxHeight: '90vh', overflowY: 'auto', padding: '20px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
          <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 800 }}>Comprobante</h3>
          <button onClick={onClose} style={{ background: '#f0f0f0', border: 'none', borderRadius: '8px', width: '32px', height: '32px', cursor: 'pointer', fontSize: '16px', fontWeight: 700 }}>×</button>
        </div>
        {err && <Vacio texto={err} />}
        {!data && !err && <Vacio texto="Cargando…" />}
        {data && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {data.image_url
              ? <img src={data.image_url} alt="Comprobante" style={{ width: '100%', borderRadius: '12px', objectFit: 'contain', maxHeight: '52vh', background: '#f5f5f5' }} />
              : <Vacio texto="Sin imagen." />}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 18px', fontSize: '13px', color: '#333' }}>
              <span><strong>Tipo:</strong> {TIPO_LABEL[data.tipo] ?? data.tipo}</span>
              <span><strong>Estado:</strong> {data.estado}</span>
              {data.monto != null && <span><strong>Monto:</strong> {fmt(data.monto)}</span>}
              {data.bono != null && <span><strong>Bono:</strong> {fmt(data.bono)}</span>}
              {data.contacto && <span><strong>Contacto:</strong> {data.contacto}</span>}
              <span><strong>Fecha:</strong> {fechaCorta(data.created_at)}</span>
              {data.resolved_by_name && <span><strong>Resuelto por:</strong> {data.resolved_by_name}</span>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Listas de detalle ───────────────────────────────────────────────────────
type RowStyle = React.CSSProperties;
const rowBase: RowStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', padding: '10px 4px', borderBottom: '1px solid #f3f3f3' };

function deltaColor(n: number) { return n < 0 ? '#c0392b' : '#1a7a3a'; }
function deltaTxt(n: number)   { return `${n > 0 ? '+' : ''}${fmt(n)}`; }

function BilleteraDetalle({ onOpenComp }: { onOpenComp: (id: string) => void }) {
  const [rows, setRows] = useState<any[] | null>(null);
  useEffect(() => {
    fetch('/api/caja/operador?view=billetera').then((r) => r.json()).then((d) => setRows(d.movimientos ?? [])).catch(() => setRows([]));
  }, []);
  if (rows === null) return <Vacio texto="Cargando…" />;
  if (rows.length === 0) return <Vacio texto="Todavía no tenés movimientos en tu billetera." />;
  return (
    <div>
      {rows.map((m) => (
        <div key={m.id} onClick={() => m.comprobante_id && onOpenComp(m.comprobante_id)} style={{ ...rowBase, cursor: m.comprobante_id ? 'pointer' : 'default' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: '13px', fontWeight: 700, color: '#222' }}>{TIPO_LABEL[m.tipo] ?? m.tipo}</div>
            <div style={{ fontSize: '11px', color: '#999' }}>{fechaCorta(m.created_at)}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '14px', fontWeight: 800, color: deltaColor(m.billetera_delta) }}>{deltaTxt(m.billetera_delta)}</div>
            <div style={{ fontSize: '12px', color: '#666' }}>saldo {fmt(m.saldo_corriendo)}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function PozoDetalle() {
  const [rows, setRows] = useState<any[] | null>(null);
  useEffect(() => {
    fetch('/api/caja/operador?view=pozo').then((r) => r.json()).then((d) => setRows(d.movimientos ?? [])).catch(() => setRows([]));
  }, []);
  if (rows === null) return <Vacio texto="Cargando…" />;
  if (rows.length === 0) return <Vacio texto="No hay movimientos del pozo todavía." />;
  return (
    <div>
      {rows.map((m) => (
        <div key={m.id} style={rowBase}>
          <div>
            <div style={{ fontSize: '13px', fontWeight: 700, color: '#222' }}>{TIPO_LABEL[m.tipo] ?? m.tipo}</div>
            <div style={{ fontSize: '11px', color: '#999' }}>{fechaCorta(m.created_at)}</div>
          </div>
          <div style={{ fontSize: '14px', fontWeight: 800, color: deltaColor(m.fichas_delta) }}>{deltaTxt(m.fichas_delta)}</div>
        </div>
      ))}
    </div>
  );
}

function HoyDetalle({ onOpenComp }: { onOpenComp: (id: string) => void }) {
  const [rows, setRows] = useState<any[] | null>(null);
  useEffect(() => {
    fetch('/api/caja/operador?view=hoy').then((r) => r.json()).then((d) => setRows(d.movimientos ?? [])).catch(() => setRows([]));
  }, []);
  if (rows === null) return <Vacio texto="Cargando…" />;
  if (rows.length === 0) return <Vacio texto="No registraste movimientos hoy." />;
  return (
    <div>
      {rows.map((m) => (
        <div key={m.id} onClick={() => m.comprobante_id && onOpenComp(m.comprobante_id)} style={{ ...rowBase, cursor: m.comprobante_id ? 'pointer' : 'default' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: '13px', fontWeight: 700, color: '#222' }}>
              {TIPO_LABEL[m.tipo] ?? m.tipo}
              {m.comprobante_id && <span style={{ fontSize: '11px', color: '#1d6fb8', marginLeft: '8px' }}>ver comprobante →</span>}
            </div>
            <div style={{ fontSize: '11px', color: '#999' }}>{fechaCorta(m.created_at)} · monto {fmt(m.monto)}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            {m.billetera_delta !== 0 && <div style={{ fontSize: '13px', fontWeight: 700, color: deltaColor(m.billetera_delta) }}>billetera {deltaTxt(m.billetera_delta)}</div>}
            {m.fichas_delta !== 0 && <div style={{ fontSize: '12px', color: '#888' }}>fichas {deltaTxt(m.fichas_delta)}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

function PendientesDetalle() {
  const [rows, setRows] = useState<any[] | null>(null);
  useEffect(() => {
    fetch('/api/caja/operador?view=pendientes').then((r) => r.json()).then((d) => setRows(d.comprobantes ?? [])).catch(() => setRows([]));
  }, []);
  if (rows === null) return <Vacio texto="Cargando…" />;
  if (rows.length === 0) return <Vacio texto="No hay comprobantes pendientes." />;
  return (
    <div>
      {rows.map((c) => (
        <Link key={c.id} href={c.tipo === 'pago' ? '/pagos' : '/cargas'} style={{ ...rowBase, textDecoration: 'none', color: 'inherit' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: '13px', fontWeight: 700, color: '#222' }}>
              {TIPO_LABEL[c.tipo] ?? c.tipo}
              <span style={{ fontSize: '11px', color: '#1d6fb8', marginLeft: '8px' }}>verificar en {c.tipo === 'pago' ? 'Pagos' : 'Cargas'} →</span>
            </div>
            <div style={{ fontSize: '11px', color: '#999' }}>{c.contacto ?? '—'} · {fechaCorta(c.created_at)}</div>
          </div>
          {c.monto != null && c.monto > 0 && <div style={{ fontSize: '14px', fontWeight: 800, color: '#111' }}>{fmt(c.monto)}</div>}
        </Link>
      ))}
    </div>
  );
}

// ── Componente principal ───────────────────────────────────────────────────────
export default function MiCajaClient() {
  const [data, setData]   = useState<Resumen | null>(null);
  const [vista, setVista] = useState<Vista>('resumen');
  const [compId, setCompId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/caja/operador');
      if (!res.ok) return;
      setData(await res.json());
    } catch {}
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);

  if (!data) return <Vacio texto="Cargando tu caja…" />;

  const off = !data.caja_enabled;

  if (vista !== 'resumen') {
    const title = vista === 'billetera' ? 'Mi billetera'
      : vista === 'pozo' ? 'Pozo de fichas'
      : vista === 'hoy' ? 'Mis movimientos de hoy'
      : 'Comprobantes pendientes';
    return (
      <>
        <BackBar title={title} onBack={() => setVista('resumen')} />
        {vista === 'billetera'  && <BilleteraDetalle onOpenComp={setCompId} />}
        {vista === 'pozo'       && <PozoDetalle />}
        {vista === 'hoy'        && <HoyDetalle onOpenComp={setCompId} />}
        {vista === 'pendientes' && <PendientesDetalle />}
        {compId && <ComprobanteModal id={compId} onClose={() => setCompId(null)} />}
      </>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      {off && (
        <div style={{ background: '#f0f0f0', borderRadius: '12px', padding: '12px 16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '16px' }}>🚫</span>
          <span style={{ fontSize: '13px', fontWeight: 700, color: '#888' }}>Caja desactivada — los saldos no se están moviendo.</span>
        </div>
      )}

      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
        <Card label="Mi billetera"  value={fmt(data.mi_saldo)} sub="fichas en tu caja" off={off} onClick={() => setVista('billetera')} />
        <Card label="Pozo de fichas" value={fmt(data.pozo)} sub="stock disponible" dark off={off} onClick={() => setVista('pozo')} />
      </div>
      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
        <Card label="Mis movimientos de hoy" value={fmt(data.mov_hoy_count)} sub="registrados hoy" off={off} onClick={() => setVista('hoy')} />
        <Card label="Pendientes" value={fmt(data.pendientes_count)} sub="comprobantes por verificar" off={off} onClick={() => setVista('pendientes')} badge={data.pendientes_count} />
      </div>
    </div>
  );
}
