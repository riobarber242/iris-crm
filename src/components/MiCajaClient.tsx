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
  carga: 'Carga', pago: 'Pago', descarga: 'Descarga', sueldo: 'Sueldo', traspaso: 'Traspaso', pago_agente: 'Pago agente',
};

// Colores por tipo de movimiento (unificado con FichasClient):
//   carga→verde · pago→rojo · sueldo→azul · descarga→naranja · pago_agente→violeta.
const TIPO_STYLE: Record<string, { bg: string; fg: string }> = {
  carga:       { bg: '#e8fff0', fg: '#1a7a3a' },
  pago:        { bg: '#fff0f0', fg: '#c0392b' },
  sueldo:      { bg: '#e6f0ff', fg: '#1d4ed8' },
  descarga:    { bg: '#fff3e0', fg: '#d97706' },
  pago_agente: { bg: '#f0eaff', fg: '#6b3fb0' },
  traspaso:    { bg: '#e6f4ff', fg: '#1d6fb8' },
};

// Chip de etiqueta de tipo con su color. `tipo` puede venir como 'pago' con la
// marca pago_agente: el caller decide qué clave usar.
function TipoChip({ tipo }: { tipo: string }) {
  const s = TIPO_STYLE[tipo] ?? { bg: '#eee', fg: '#555' };
  return (
    <span style={{
      fontSize: '11px', fontWeight: 800, padding: '2px 9px', borderRadius: '999px',
      background: s.bg, color: s.fg, whiteSpace: 'nowrap',
    }}>
      {TIPO_LABEL[tipo] ?? tipo}
    </span>
  );
}

type Resumen = {
  caja_enabled: boolean; degraded?: boolean;
  mi_saldo: number; pozo: number; mov_hoy_count: number; pendientes_count: number;
  sueldo_diario: number; whatsapp_agente: string; operador_name: string;
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
          <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: '4px', alignItems: 'flex-start' }}>
            <TipoChip tipo={m.tipo} />
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
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', alignItems: 'flex-start' }}>
            <TipoChip tipo={m.tipo} />
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
          <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: '4px', alignItems: 'flex-start' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <TipoChip tipo={m.tipo} />
              {m.comprobante_id && <span style={{ fontSize: '11px', color: '#1d6fb8' }}>ver comprobante →</span>}
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
          <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: '4px', alignItems: 'flex-start' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <TipoChip tipo={c.tipo} />
              <span style={{ fontSize: '11px', color: '#1d6fb8' }}>verificar en {c.tipo === 'pago' ? 'Pagos' : 'Cargas'} →</span>
            </div>
            <div style={{ fontSize: '11px', color: '#999' }}>{c.contacto ?? '—'} · {fechaCorta(c.created_at)}</div>
          </div>
          {c.monto != null && c.monto > 0 && <div style={{ fontSize: '14px', fontWeight: 800, color: '#111' }}>{fmt(c.monto)}</div>}
        </Link>
      ))}
    </div>
  );
}

// ── Acciones del operador (Etapa 5): sueldo + descarga ──────────────────────────

// Normaliza el WhatsApp del agente a formato internacional para wa.me. El número
// se guarda sin "+"; si no empieza con 54 (Argentina) se lo anteponemos, así
// funciona tanto si cargan "1112345678" como "5491112345678".
function waLink(numeroRaw: string, nombre: string, monto: number): string {
  const digits = String(numeroRaw).replace(/\D/g, '');
  const full   = digits.startsWith('54') ? digits : `54${digits}`;
  const fecha  = new Date().toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const text   = `Descarga de ${nombre} $${fmt(monto)} ${fecha}`;
  return `https://wa.me/${full}?text=${encodeURIComponent(text)}`;
}

const modalOverlay: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000,
  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px',
};
const modalCard: React.CSSProperties = {
  background: '#fff', borderRadius: '16px', maxWidth: '380px', width: '100%', padding: '22px',
  display: 'flex', flexDirection: 'column', gap: '14px',
};
const btnPrimary: React.CSSProperties = {
  background: '#C8FF00', color: '#000', fontWeight: 800, fontSize: '14px', border: 'none',
  borderRadius: '10px', padding: '11px 18px', cursor: 'pointer', flex: 1,
};
const btnGhost: React.CSSProperties = {
  background: '#F0F0F0', color: '#666', fontWeight: 700, fontSize: '14px', border: 'none',
  borderRadius: '10px', padding: '11px 18px', cursor: 'pointer', flex: 1,
};

// Modal de confirmación de cobro de sueldo.
function SueldoModal({ monto, busy, error, onConfirm, onClose }: {
  monto: number; busy: boolean; error: string | null; onConfirm: () => void; onClose: () => void;
}) {
  return (
    <div onClick={busy ? undefined : onClose} style={modalOverlay}>
      <div onClick={(e) => e.stopPropagation()} style={modalCard}>
        <h3 style={{ margin: 0, fontSize: '17px', fontWeight: 800 }}>Cobrar sueldo</h3>
        <p style={{ margin: 0, fontSize: '14px', color: '#444', lineHeight: 1.5 }}>
          ¿Confirmar cobro de sueldo por <strong>${fmt(monto)}</strong>? Se descontará de tu billetera.
        </p>
        {error && <div style={{ background: '#FFE5E5', color: '#CC3333', borderRadius: '10px', padding: '10px 12px', fontSize: '13px', fontWeight: 600 }}>{error}</div>}
        <div style={{ display: 'flex', gap: '10px' }}>
          <button onClick={onClose} disabled={busy} style={btnGhost}>Cancelar</button>
          <button onClick={onConfirm} disabled={busy} style={btnPrimary}>{busy ? '…' : 'Confirmar'}</button>
        </div>
      </div>
    </div>
  );
}

// Modal de descarga: el operador ingresa el monto; al confirmar abrimos el wa.me
// y creamos el comprobante pendiente. Si el agente no configuró su WhatsApp, no
// se puede continuar.
function DescargaModal({ whatsappAgente, operadorName, busy, error, done, onConfirm, onClose }: {
  whatsappAgente: string; operadorName: string; busy: boolean; error: string | null; done: boolean;
  onConfirm: (monto: number) => void; onClose: () => void;
}) {
  const [montoStr, setMontoStr] = useState('');
  const sinWhatsapp = !whatsappAgente;
  const monto = parseInt(montoStr.replace(/\D/g, ''), 10);
  const montoValido = Number.isInteger(monto) && monto > 0;

  return (
    <div onClick={busy ? undefined : onClose} style={modalOverlay}>
      <div onClick={(e) => e.stopPropagation()} style={modalCard}>
        <h3 style={{ margin: 0, fontSize: '17px', fontWeight: 800 }}>Descargar al agente</h3>

        {sinWhatsapp ? (
          <div style={{ background: '#FFF6E0', color: '#9a6b00', borderRadius: '10px', padding: '12px 14px', fontSize: '13px', fontWeight: 600, lineHeight: 1.5 }}>
            El agente no configuró su número de WhatsApp todavía.
          </div>
        ) : done ? (
          <div style={{ background: '#e8fff0', color: '#1a7a3a', borderRadius: '10px', padding: '12px 14px', fontSize: '13px', fontWeight: 700, lineHeight: 1.5 }}>
            Comprobante enviado, esperando verificación del agente.
          </div>
        ) : (
          <>
            <p style={{ margin: 0, fontSize: '14px', color: '#444', lineHeight: 1.5 }}>
              Ingresá el monto a descargar. Se abrirá el WhatsApp del agente y se creará el comprobante pendiente.
            </p>
            <input
              type="number" min="1" step="1" value={montoStr} autoFocus
              onChange={(e) => setMontoStr(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && montoValido && !busy) onConfirm(monto); }}
              placeholder="Monto a descargar"
              style={{ padding: '11px 13px', border: '2px solid #eee', borderRadius: '10px', fontSize: '15px', fontWeight: 700, outline: 'none', background: '#F7F7F7' }}
            />
            {error && <div style={{ background: '#FFE5E5', color: '#CC3333', borderRadius: '10px', padding: '10px 12px', fontSize: '13px', fontWeight: 600 }}>{error}</div>}
          </>
        )}

        <div style={{ display: 'flex', gap: '10px' }}>
          <button onClick={onClose} disabled={busy} style={btnGhost}>{done ? 'Cerrar' : 'Cancelar'}</button>
          {!sinWhatsapp && !done && (
            <button onClick={() => montoValido && onConfirm(monto)} disabled={busy || !montoValido} style={{ ...btnPrimary, opacity: montoValido ? 1 : 0.5, cursor: montoValido && !busy ? 'pointer' : 'not-allowed' }}>
              {busy ? '…' : 'Confirmar'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Componente principal ───────────────────────────────────────────────────────
export default function MiCajaClient() {
  const [data, setData]   = useState<Resumen | null>(null);
  const [vista, setVista] = useState<Vista>('resumen');
  const [compId, setCompId] = useState<string | null>(null);

  // Acciones Etapa 5: sueldo y descarga.
  const [sueldoOpen, setSueldoOpen]   = useState(false);
  const [descargaOpen, setDescargaOpen] = useState(false);
  const [actionBusy, setActionBusy]   = useState(false);
  const [actionErr, setActionErr]     = useState<string | null>(null);
  const [descargaDone, setDescargaDone] = useState(false);
  const [toast, setToast]             = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/caja/operador');
      if (!res.ok) return;
      setData(await res.json());
    } catch {}
  }, []);

  async function confirmarSueldo() {
    setActionBusy(true); setActionErr(null);
    try {
      const res = await fetch('/api/caja/operador?accion=sueldo', { method: 'POST' });
      if (!res.ok) { setActionErr(await res.text().catch(() => '') || 'No se pudo cobrar el sueldo'); return; }
      const r = await res.json();
      setSueldoOpen(false);
      setToast(`Sueldo de $${fmt(Number(r.monto))} cobrado.`);
      await load();
    } catch {
      setActionErr('Error de red');
    } finally {
      setActionBusy(false);
    }
  }

  async function confirmarDescarga(monto: number) {
    if (!data) return;
    setActionBusy(true); setActionErr(null);
    try {
      // (a) Abrir el WhatsApp del agente en una pestaña nueva.
      window.open(waLink(data.whatsapp_agente, data.operador_name, monto), '_blank', 'noopener');
      // (b) Crear el comprobante de descarga pendiente.
      const res = await fetch('/api/caja/operador?accion=descarga', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ monto }),
      });
      if (!res.ok) { setActionErr(await res.text().catch(() => '') || 'No se pudo crear la descarga'); return; }
      // (c) Confirmación dentro del modal.
      setDescargaDone(true);
      await load();
    } catch {
      setActionErr('Error de red');
    } finally {
      setActionBusy(false);
    }
  }

  function closeDescarga() {
    setDescargaOpen(false); setDescargaDone(false); setActionErr(null);
  }

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

      {/* Acciones del operador (Etapa 5). Solo con la caja encendida. */}
      {!off && (
        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginTop: '2px' }}>
          <button
            onClick={() => { setActionErr(null); setSueldoOpen(true); }}
            style={{ flex: 1, minWidth: '180px', background: '#e6f0ff', color: '#1d4ed8', fontWeight: 800, fontSize: '14px', border: 'none', borderRadius: '12px', padding: '14px 18px', cursor: 'pointer' }}
            className="nav-3d"
          >
            Cobrar sueldo (${fmt(data.sueldo_diario)})
          </button>
          <button
            onClick={() => { setActionErr(null); setDescargaDone(false); setDescargaOpen(true); }}
            style={{ flex: 1, minWidth: '180px', background: '#fff3e0', color: '#d97706', fontWeight: 800, fontSize: '14px', border: 'none', borderRadius: '12px', padding: '14px 18px', cursor: 'pointer' }}
            className="nav-3d"
          >
            Descargar al agente
          </button>
        </div>
      )}

      {toast && (
        <div onClick={() => setToast(null)} style={{ background: '#e8fff0', color: '#1a7a3a', borderRadius: '12px', padding: '12px 16px', fontSize: '13px', fontWeight: 700, cursor: 'pointer' }}>
          ✓ {toast}
        </div>
      )}

      {sueldoOpen && (
        <SueldoModal
          monto={data.sueldo_diario}
          busy={actionBusy}
          error={actionErr}
          onConfirm={confirmarSueldo}
          onClose={() => { if (!actionBusy) { setSueldoOpen(false); setActionErr(null); } }}
        />
      )}
      {descargaOpen && (
        <DescargaModal
          whatsappAgente={data.whatsapp_agente}
          operadorName={data.operador_name}
          busy={actionBusy}
          error={actionErr}
          done={descargaDone}
          onConfirm={confirmarDescarga}
          onClose={() => { if (!actionBusy) closeDescarga(); }}
        />
      )}
    </div>
  );
}
