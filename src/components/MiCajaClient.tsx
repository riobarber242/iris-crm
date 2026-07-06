'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { getSupabaseBrowser } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';

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
  carga: 'Carga', pago: 'Pago', descarga: 'Descarga', sueldo: 'Sueldo', traspaso: 'Traspaso', pago_agente: 'Pago agente', ajuste: 'Ajuste',
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
  ajuste:      { bg: '#eef1f4', fg: '#475569' },
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

type ResumenTurno = {
  total_cargas: number; total_pagos: number; total_descargas: number; total_sueldo: number;
  saldo_a_traspasar: number;
};
type OperadorDestino = { id: string; name: string };
type Resumen = {
  caja_enabled: boolean; casino_enabled?: boolean; degraded?: boolean;
  mi_saldo: number; pozo: number; mov_hoy_count: number; pendientes_count: number;
  sueldo_diario: number; whatsapp_agente: string; operador_name: string;
  resumen_turno: ResumenTurno; operadores_destino: OperadorDestino[];
  traspaso_a_verificar?: { id: string; origen_name: string; monto: number } | null;
  turno_cerrado?: boolean;
};
type Vista = 'resumen' | 'billetera' | 'pozo' | 'hoy' | 'pendientes' | 'cierres';

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

// ── Mis cierres de turno (Etapa 6) ──────────────────────────────────────────────
function CierresDetalle() {
  const [rows, setRows] = useState<any[] | null>(null);
  useEffect(() => {
    fetch('/api/caja/operador?view=cierres').then((r) => r.json()).then((d) => setRows(d.cierres ?? [])).catch(() => setRows([]));
  }, []);
  if (rows === null) return <Vacio texto="Cargando…" />;
  if (rows.length === 0) return <Vacio texto="Todavía no cerraste ningún turno." />;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      {rows.map((c) => (
        <div key={c.id} style={{ background: '#fff', borderRadius: '12px', padding: '12px 14px', boxShadow: '0 1px 5px rgba(0,0,0,0.05)', display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '14px', fontWeight: 800, color: '#111' }}>
              Traspaso ${fmt(c.total_traspaso)} <span style={{ color: '#888', fontWeight: 600 }}>→ {c.destino_name}</span>
            </span>
            <span style={{ fontSize: '12px', color: '#999' }}>{fechaCorta(c.turno_fin_at || c.created_at)}</span>
          </div>
          <div style={{ display: 'flex', gap: '6px 14px', flexWrap: 'wrap', fontSize: '12px' }}>
            <span style={{ color: TIPO_STYLE.carga.fg, fontWeight: 700 }}>cargas ${fmt(c.total_cargas)}</span>
            <span style={{ color: TIPO_STYLE.pago.fg, fontWeight: 700 }}>pagos ${fmt(c.total_pagos)}</span>
            <span style={{ color: TIPO_STYLE.descarga.fg, fontWeight: 700 }}>descargas ${fmt(c.total_descargas)}</span>
            <span style={{ color: TIPO_STYLE.sueldo.fg, fontWeight: 700 }}>sueldo ${fmt(c.total_sueldo)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Acciones del operador (Etapa 5: sueldo + descarga · Etapa 6: cierre) ─────────

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

// Modal de descarga: el operador ingresa el monto y adjunta SÍ o SÍ la foto del
// comprobante. Al confirmar, la descarga se aplica al toque (mueve la plata al
// agente) y la imagen se publica en el chat interno. No hay verificación.
function DescargaModal({ busy, error, done, onConfirm, onClose }: {
  busy: boolean; error: string | null; done: boolean;
  onConfirm: (monto: number, file: File) => void; onClose: () => void;
}) {
  const [montoStr, setMontoStr] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const monto = parseInt(montoStr.replace(/\D/g, ''), 10);
  const montoValido = Number.isInteger(monto) && monto > 0;
  const listo = montoValido && !!file;

  function onPick(f: File | null) {
    setFile(f);
    if (preview) URL.revokeObjectURL(preview);
    setPreview(f ? URL.createObjectURL(f) : null);
  }

  return (
    <div onClick={busy ? undefined : onClose} style={modalOverlay}>
      <div onClick={(e) => e.stopPropagation()} style={modalCard}>
        <h3 style={{ margin: 0, fontSize: '17px', fontWeight: 800 }}>Descargar al agente</h3>

        {done ? (
          <div style={{ background: '#e8fff0', color: '#1a7a3a', borderRadius: '10px', padding: '12px 14px', fontSize: '13px', fontWeight: 700, lineHeight: 1.5 }}>
            Descarga registrada. El comprobante se publicó en el chat interno y la plata pasó a la billetera del agente.
          </div>
        ) : (
          <>
            <p style={{ margin: 0, fontSize: '14px', color: '#444', lineHeight: 1.5 }}>
              Ingresá el monto y adjuntá la foto del comprobante (obligatoria). Al confirmar, la descarga se aplica al instante y se publica en el chat interno.
            </p>
            <input
              type="number" min="1" step="1" value={montoStr} autoFocus
              onChange={(e) => setMontoStr(e.target.value)}
              placeholder="Monto a descargar"
              style={{ padding: '11px 13px', border: '2px solid #eee', borderRadius: '10px', fontSize: '15px', fontWeight: 700, outline: 'none', background: '#F7F7F7' }}
            />
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <span style={{ fontSize: '13px', fontWeight: 700, color: '#444' }}>Foto del comprobante (obligatoria)</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', background: '#f0f0f0', color: '#333', fontWeight: 700, fontSize: '13px', padding: '10px 14px', borderRadius: '10px', cursor: 'pointer' }}>
                  <span style={{ fontSize: '15px' }}>📎</span> Adjuntar foto
                  <input
                    type="file" accept="image/*"
                    onChange={(e) => onPick(e.target.files?.[0] ?? null)}
                    style={{ display: 'none' }}
                  />
                </label>
                {file && <span style={{ fontSize: '12px', color: '#666', wordBreak: 'break-all' }}>{file.name}</span>}
              </div>
            </div>
            {preview && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={preview} alt="comprobante" style={{ maxHeight: '140px', borderRadius: '10px', objectFit: 'contain', alignSelf: 'flex-start' }} />
            )}
            {error && <div style={{ background: '#FFE5E5', color: '#CC3333', borderRadius: '10px', padding: '10px 12px', fontSize: '13px', fontWeight: 600 }}>{error}</div>}
          </>
        )}

        <div style={{ display: 'flex', gap: '10px' }}>
          <button onClick={onClose} disabled={busy} style={btnGhost}>{done ? 'Cerrar' : 'Cancelar'}</button>
          {!done && (
            <button onClick={() => listo && file && onConfirm(monto, file)} disabled={busy || !listo} style={{ ...btnPrimary, opacity: listo ? 1 : 0.5, cursor: listo && !busy ? 'pointer' : 'not-allowed' }}>
              {busy ? '…' : 'Confirmar descarga'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// Modal de cierre de turno (2 pasos): (1) resumen del turno; (2) destino del
// traspaso + confirmación. Si no hay otros operadores, salta directo a "sin
// traspaso" (depositar al agente).
function CerrarTurnoModal({ resumen, operadores, busy, error, done, onConfirm, onClose }: {
  resumen: ResumenTurno; operadores: OperadorDestino[];
  busy: boolean; error: string | null; done: boolean;
  onConfirm: (destinoId: string | null, destinoName: string) => void; onClose: () => void;
}) {
  const soloYo = operadores.length === 0;
  const [paso, setPaso] = useState<1 | 2>(1);
  // '' = sin traspaso (al agente); si hay un solo destino posible igual se elige a mano.
  const [destinoId, setDestinoId] = useState<string>('');

  const destinoName = destinoId ? (operadores.find((o) => o.id === destinoId)?.name ?? '—') : 'el agente';
  const monto = resumen.saldo_a_traspasar;

  const Fila = ({ label, val, color }: { label: string; val: number; color?: string }) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
      <span style={{ color: '#666' }}>{label}</span>
      <span style={{ fontWeight: 800, color: color ?? '#111' }}>${fmt(val)}</span>
    </div>
  );

  return (
    <div onClick={busy ? undefined : onClose} style={modalOverlay}>
      <div onClick={(e) => e.stopPropagation()} style={modalCard}>
        <h3 style={{ margin: 0, fontSize: '17px', fontWeight: 800 }}>Cerrar turno</h3>

        {done ? (
          <div style={{ background: '#e8fff0', color: '#1a7a3a', borderRadius: '10px', padding: '12px 14px', fontSize: '13px', fontWeight: 700, lineHeight: 1.5 }}>
            Turno cerrado. Tu billetera quedó en 0 y el receptor confirmará la recepción del traspaso desde el chat interno.
          </div>
        ) : paso === 1 ? (
          <>
            <p style={{ margin: 0, fontSize: '13px', color: '#888' }}>Resumen de tu turno:</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', background: '#F7F7F7', borderRadius: '10px', padding: '12px 14px' }}>
              <Fila label="Cargas"    val={resumen.total_cargas}    color={TIPO_STYLE.carga.fg} />
              <Fila label="Pagos"     val={resumen.total_pagos}     color={TIPO_STYLE.pago.fg} />
              <Fila label="Descargas" val={resumen.total_descargas} color={TIPO_STYLE.descarga.fg} />
              <Fila label="Sueldo"    val={resumen.total_sueldo}    color={TIPO_STYLE.sueldo.fg} />
              <div style={{ borderTop: '1px solid #e3e3e3', margin: '4px 0' }} />
              <Fila label="Saldo a traspasar" val={monto} color={TIPO_STYLE.traspaso.fg} />
            </div>
          </>
        ) : (
          <>
            <p style={{ margin: 0, fontSize: '14px', color: '#444', lineHeight: 1.5 }}>
              ¿A quién le traspasás los <strong>${fmt(monto)}</strong> restantes?
            </p>
            <select
              value={destinoId}
              onChange={(e) => setDestinoId(e.target.value)}
              style={{ padding: '11px 13px', border: '2px solid #eee', borderRadius: '10px', fontSize: '14px', fontWeight: 700, outline: 'none', background: '#F7F7F7', color: '#222' }}
            >
              <option value="">Sin traspaso — depositar al agente</option>
              {operadores.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
            <p style={{ margin: 0, fontSize: '13px', color: '#444' }}>
              ¿Cerrar turno y traspasar <strong>${fmt(monto)}</strong> a <strong>{destinoName}</strong>?
            </p>
          </>
        )}

        {error && <div style={{ background: '#FFE5E5', color: '#CC3333', borderRadius: '10px', padding: '10px 12px', fontSize: '13px', fontWeight: 600 }}>{error}</div>}

        <div style={{ display: 'flex', gap: '10px' }}>
          {done ? (
            <button onClick={onClose} style={btnPrimary}>Cerrar</button>
          ) : paso === 1 ? (
            <>
              <button onClick={onClose} disabled={busy} style={btnGhost}>Cancelar</button>
              <button onClick={() => setPaso(2)} disabled={busy} style={btnPrimary}>Continuar</button>
            </>
          ) : (
            <>
              <button onClick={() => (soloYo ? onClose() : setPaso(1))} disabled={busy} style={btnGhost}>
                {soloYo ? 'Cancelar' : 'Atrás'}
              </button>
              <button onClick={() => onConfirm(destinoId || null, destinoName)} disabled={busy} style={btnPrimary}>
                {busy ? '…' : 'Cerrar turno'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Componente principal ───────────────────────────────────────────────────────
export default function MiCajaClient() {
  const [data, setData]   = useState<Resumen | null>(null);
  // tenant del usuario: filtra el postgres_changes de movimientos por tenant.
  const { agent } = useAuth();
  const tid = agent?.tenant_id ?? null;
  const [vista, setVista] = useState<Vista>('resumen');
  const [compId, setCompId] = useState<string | null>(null);

  // Acciones Etapa 5 (sueldo/descarga) y Etapa 6 (cierre de turno).
  const [sueldoOpen, setSueldoOpen]   = useState(false);
  const [descargaOpen, setDescargaOpen] = useState(false);
  const [cerrarOpen, setCerrarOpen]   = useState(false);
  const [actionBusy, setActionBusy]   = useState(false);
  const [actionErr, setActionErr]     = useState<string | null>(null);
  const [descargaDone, setDescargaDone] = useState(false);
  const [cerrarDone, setCerrarDone]   = useState(false);
  const [toast, setToast]             = useState<string | null>(null);
  const [verifErr, setVerifErr]       = useState<string | null>(null);

  // Saldo de fichas del agente en el casino. Solo se muestra en tenants con
  // casino_deposit_enabled=true (lo decide el backend vía { enabled }).
  const [casinoEnabled, setCasinoEnabled] = useState(false);
  const [casinoBalance, setCasinoBalance] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/caja/operador');
      if (!res.ok) return;
      setData(await res.json());
    } catch {}
  }, []);

  // Saldo del casino: best-effort, gateado por tenant en el backend. Mismo patrón
  // que FichasClient; se refresca junto con el resumen.
  const fetchCasinoBalance = useCallback(async () => {
    try {
      const res = await fetch('/api/casino/balance');
      if (!res.ok) return;
      const j = await res.json();
      setCasinoEnabled(!!j.enabled);
      if (j.enabled && typeof j.balance === 'number') setCasinoBalance(j.balance);
    } catch {}
  }, []);

  // Verificar el traspaso recibido (el operador es el destino). Pega al endpoint
  // compartido /api/caja/traspaso; el backend solo deja pasar al destino exacto
  // del comprobante. En éxito, recarga el resumen.
  async function verificarTraspasoRecibido(id: string) {
    setActionBusy(true); setVerifErr(null);
    try {
      const res = await fetch('/api/caja/traspaso?accion=verificar', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comprobanteId: id }),
      });
      if (!res.ok) { setVerifErr(await res.text().catch(() => '') || 'No se pudo verificar el traspaso'); return; }
      setToast('Traspaso verificado. El saldo se acreditó en tu billetera.');
      await load();
    } catch {
      setVerifErr('Error de red');
    } finally {
      setActionBusy(false);
    }
  }

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

  async function confirmarDescarga(monto: number, file: File) {
    if (!data) return;
    setActionBusy(true); setActionErr(null);
    try {
      // Descarga inmediata con foto: el server sube la imagen, mueve la plata al
      // agente y publica el comprobante en el chat interno (un solo request).
      const form = new FormData();
      form.append('monto', String(monto));
      form.append('file', file);
      const res = await fetch('/api/caja/operador?accion=descarga', { method: 'POST', body: form });
      if (!res.ok) { setActionErr(await res.text().catch(() => '') || 'No se pudo registrar la descarga'); return; }
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

  async function confirmarCerrar(destinoId: string | null, destinoName: string) {
    if (!data) return;
    setActionBusy(true); setActionErr(null);
    try {
      // (a) Cerrar el turno YA: vacía la billetera y crea el comprobante de
      //     traspaso pendiente de verificación del receptor (devuelve su id).
      const res = await fetch('/api/caja/operador?accion=cerrar_turno', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ destinoId }),
      });
      if (!res.ok) { setActionErr(await res.text().catch(() => '') || 'No se pudo cerrar el turno'); return; }
      const { comprobanteId, monto } = await res.json().catch(() => ({} as any));

      // (b) Postear el cierre al chat interno con el comprobante_id embebido en
      //     el content JSON, para que el receptor lo verifique desde el chat.
      //     Best-effort: si el chat falla, el cierre ya quedó hecho igual.
      const montoTraspaso = Number(monto ?? data.resumen_turno.saldo_a_traspasar);
      const text = `🔄 Cierre de turno — ${data.operador_name} traspasa $${fmt(montoTraspaso)} a ${destinoName}. Confirmá la recepción.`;
      try {
        await fetch('/api/internal/messages', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: JSON.stringify({ _type: 'traspaso', comprobante_id: comprobanteId ?? null, text }) }),
        });
      } catch { /* no bloquea el cierre */ }

      // (c) Confirmación dentro del modal.
      setCerrarDone(true);
      await load();
    } catch {
      setActionErr('Error de red');
    } finally {
      setActionBusy(false);
    }
  }

  function closeCerrar() {
    setCerrarOpen(false); setCerrarDone(false); setActionErr(null);
  }

  useEffect(() => {
    load();
    fetchCasinoBalance();
    // Poll de respaldo relajado a 30 s: la inmediatez la da el Broadcast de Fase 2.
    const t = setInterval(() => { load(); fetchCasinoBalance(); }, 30_000);

    // Fase 2: señal de movimiento (via AdminShell) → refresca billetera/pozo/movs al instante.
    const onMov = () => { load(); fetchCasinoBalance(); };
    window.addEventListener('iris:movimiento-broadcast', onMov);

    // postgres_changes de respaldo (dead bajo RLS para la anon key, se mantiene por si acaso).
    const sb = getSupabaseBrowser();
    let ch: any = null;
    if (sb && tid) {
      ch = sb.channel('realtime-mi-caja')
        .on('postgres_changes' as any, { event: 'INSERT', schema: 'public', table: 'movimientos', filter: `tenant_id=eq.${tid}` }, () => { load(); fetchCasinoBalance(); })
        .subscribe();
    }

    return () => {
      clearInterval(t);
      window.removeEventListener('iris:movimiento-broadcast', onMov);
      if (sb && ch) { try { sb.removeChannel(ch); } catch (err) { console.warn('[mi-caja realtime] removeChannel falló:', err); } }
    };
  }, [load, fetchCasinoBalance, tid]);

  if (!data) return <Vacio texto="Cargando tu caja…" />;

  // La caja está "operativa" si la caja manual está encendida O el casino está
  // activo (en modo casino el pozo duerme pero la billetera sigue viva, y las
  // acciones sueldo/descarga/cierre funcionan: el guard SQL ya hace el mismo OR).
  // Usamos casino_enabled del backend (en el mismo payload) y, por las dudas,
  // también el casinoEnabled del balance, para no depender de un solo fetch.
  const cajaActiva = data.caja_enabled || data.casino_enabled || casinoEnabled;
  const off = !cajaActiva;

  if (vista !== 'resumen') {
    const title = vista === 'billetera' ? 'Mi billetera'
      : vista === 'pozo' ? 'Pozo de fichas'
      : vista === 'hoy' ? 'Mis movimientos de hoy'
      : vista === 'cierres' ? 'Mis cierres de turno'
      : 'Comprobantes pendientes';
    return (
      <>
        <BackBar title={title} onBack={() => setVista('resumen')} />
        {vista === 'billetera'  && <BilleteraDetalle onOpenComp={setCompId} />}
        {vista === 'pozo'       && <PozoDetalle />}
        {vista === 'hoy'        && <HoyDetalle onOpenComp={setCompId} />}
        {vista === 'pendientes' && <PendientesDetalle />}
        {vista === 'cierres'    && <CierresDetalle />}
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

      {/* Traspaso recibido pendiente: el operador es el destino y puede verificarlo
          desde su panel. Solo con la caja encendida (si está off, el SQL aborta). */}
      {!off && data.traspaso_a_verificar && (
        <div style={{ background: '#e6f4ff', border: '1px solid #b3dcff', borderRadius: '12px', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <span style={{ fontSize: '14px', fontWeight: 700, color: '#0b4f80' }}>
            🔄 Tenés un traspaso pendiente de {data.traspaso_a_verificar.origen_name} por ${fmt(data.traspaso_a_verificar.monto)}.
          </span>
          <span style={{ fontSize: '12px', color: '#555' }}>
            Al verificar, ese saldo se acredita en tu billetera.
          </span>
          {verifErr && (
            <div style={{ background: '#FFE5E5', color: '#CC3333', borderRadius: '10px', padding: '8px 12px', fontSize: '13px', fontWeight: 600 }}>
              {verifErr}
            </div>
          )}
          <button
            onClick={() => verificarTraspasoRecibido(data.traspaso_a_verificar!.id)}
            disabled={actionBusy}
            style={{ alignSelf: 'flex-start', background: '#1d6fb8', color: '#fff', fontWeight: 800, fontSize: '14px', border: 'none', borderRadius: '10px', padding: '11px 20px', cursor: actionBusy ? 'default' : 'pointer', opacity: actionBusy ? 0.6 : 1 }}
          >
            {actionBusy ? 'Verificando…' : 'Verificar'}
          </button>
        </div>
      )}

      {/* Saldo en el casino (admin.celuapuestas.bond) — mismo banner que Fichas.
          Solo en tenants con el casino activado. */}
      {casinoEnabled && (
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
      )}

      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
        <Card label="Mi billetera"  value={fmt(data.mi_saldo)} sub={casinoEnabled ? 'tu billetera' : 'fichas en tu caja'} off={off} onClick={() => setVista('billetera')} />
        {/* Pozo interno: solo en modo manual. Con casino activo el stock vive en
            el casino (ver banner "Saldo casino"), así que se oculta el pozo. */}
        {!casinoEnabled && (
          <Card label="Pozo de fichas" value={fmt(data.pozo)} sub="stock disponible" dark off={off} onClick={() => setVista('pozo')} />
        )}
      </div>
      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
        <Card label="Mis movimientos de hoy" value={fmt(data.mov_hoy_count)} sub="registrados hoy" off={off} onClick={() => setVista('hoy')} />
        <Card label="Pendientes" value={fmt(data.pendientes_count)} sub="comprobantes por verificar" off={off} onClick={() => setVista('pendientes')} badge={data.pendientes_count} />
      </div>

      {/* Acciones del operador (Etapa 5). Solo con la caja encendida. */}
      {!off && (
        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginTop: '2px' }}>
          <button
            onClick={() => { if (!data.turno_cerrado) { setActionErr(null); setSueldoOpen(true); } }}
            disabled={data.turno_cerrado}
            title={data.turno_cerrado ? 'Cerraste el turno; cobrás el sueldo en tu próximo turno' : undefined}
            style={{ flex: 1, minWidth: '180px', background: '#e6f0ff', color: '#1d4ed8', fontWeight: 800, fontSize: '14px', border: 'none', borderRadius: '12px', padding: '14px 18px', cursor: data.turno_cerrado ? 'not-allowed' : 'pointer', opacity: data.turno_cerrado ? 0.5 : 1 }}
            className="nav-3d"
          >
            Cobrar sueldo (${fmt(data.sueldo_diario)})
          </button>
          <button
            onClick={() => { if (!data.turno_cerrado) { setActionErr(null); setDescargaDone(false); setDescargaOpen(true); } }}
            disabled={data.turno_cerrado}
            title={data.turno_cerrado ? 'Cerraste tu turno' : undefined}
            style={{ flex: 1, minWidth: '180px', background: '#fff3e0', color: '#d97706', fontWeight: 800, fontSize: '14px', border: 'none', borderRadius: '12px', padding: '14px 18px', cursor: data.turno_cerrado ? 'not-allowed' : 'pointer', opacity: data.turno_cerrado ? 0.5 : 1 }}
            className="nav-3d"
          >
            Descargar al agente
          </button>
          <button
            onClick={() => { if (!data.turno_cerrado) { setActionErr(null); setCerrarDone(false); setCerrarOpen(true); } }}
            disabled={data.turno_cerrado}
            title={data.turno_cerrado ? 'Ya cerraste tu turno' : undefined}
            style={{ flex: 1, minWidth: '180px', background: '#e6f4ff', color: '#1d6fb8', fontWeight: 800, fontSize: '14px', border: 'none', borderRadius: '12px', padding: '14px 18px', cursor: data.turno_cerrado ? 'not-allowed' : 'pointer', opacity: data.turno_cerrado ? 0.5 : 1 }}
            className="nav-3d"
          >
            Cerrar turno
          </button>
        </div>
      )}

      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
        <Card label="Mis cierres" value="Ver" sub="historial de tus cierres de turno" off={off} onClick={() => setVista('cierres')} />
      </div>

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
          busy={actionBusy}
          error={actionErr}
          done={descargaDone}
          onConfirm={confirmarDescarga}
          onClose={() => { if (!actionBusy) closeDescarga(); }}
        />
      )}
      {cerrarOpen && (
        <CerrarTurnoModal
          resumen={data.resumen_turno}
          operadores={data.operadores_destino}
          busy={actionBusy}
          error={actionErr}
          done={cerrarDone}
          onConfirm={confirmarCerrar}
          onClose={() => { if (!actionBusy) closeCerrar(); }}
        />
      )}
    </div>
  );
}
