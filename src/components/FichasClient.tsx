'use client';

import React, { useEffect, useState } from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// Pantalla de Caja de fichas (solo admin/agent). Parte 2: stock del pozo,
// encender/apagar la caja, recargar fichas e historial de movimientos.
// Los controles manuales/destructivos del agente llegan en la Parte 4.
// ─────────────────────────────────────────────────────────────────────────────

type Billetera = {
  operador_id: string; name: string; role: string | null; saldo: number; turno_abierto: boolean;
};
type Movimiento = {
  id: string; tipo: string; monto: number; bono: number | null;
  fichas_delta: number; billetera_delta: number;
  operador_id: string | null; operador_name: string; creado_por_name: string | null;
  comprobante_id: string | null; editado: boolean; created_at: string;
};
type DescargaPend = { id: string; tipo: string; monto: number; operador_id: string; operador_name: string; destino_name: string | null; created_at: string };
type DescargaHist = { id: string; monto: number; operador_id: string; operador_name: string; verificado_por: string; verificado_at: string };
type Cierre = {
  id: string; operador_id: string; operador_name: string; destino_name: string;
  turno_inicio_at: string; turno_fin_at: string;
  total_cargas: number; total_pagos: number; total_descargas: number; total_sueldo: number;
  total_traspaso: number; billetera_inicio: number; created_at: string;
};
type Resumen = {
  caja_enabled: boolean; degraded?: boolean; stock: number; total_billeteras: number;
  billeteras: Billetera[]; movimientos: Movimiento[];
  descargas_pendientes: DescargaPend[]; descargas_historial: DescargaHist[]; mi_billetera_agente: number;
  cierres: Cierre[];
};

const HIST_PAGE = 10;

const fmt = (n: number) => n.toLocaleString('es-AR');

function formatFecha(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const fecha = d.toLocaleDateString('es-AR', { day: 'numeric', month: 'short' }).replace(/\.$/, '');
  const hora  = d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  return `${fecha} ${hora}`;
}

// Colores por tipo (unificado con MiCajaClient):
//   carga→verde · pago→rojo · sueldo→azul · descarga→naranja · pago_agente→violeta.
const TIPO_STYLE: Record<string, { bg: string; fg: string }> = {
  carga:       { bg: '#e8fff0', fg: '#1a7a3a' },
  pago:        { bg: '#fff0f0', fg: '#c0392b' },
  sueldo:      { bg: '#e6f0ff', fg: '#1d4ed8' },
  descarga:    { bg: '#fff3e0', fg: '#d97706' },
  pago_agente: { bg: '#f0eaff', fg: '#6b3fb0' },
  traspaso:    { bg: '#e6f4ff', fg: '#1d6fb8' },
};
const TIPO_LABEL: Record<string, string> = {
  carga: 'carga', pago: 'pago', sueldo: 'sueldo', descarga: 'descarga', pago_agente: 'pago agente', traspaso: 'traspaso',
};

// El pago del agente se guarda como tipo 'pago' pero no toca ninguna billetera
// (billetera_delta=0) y sube fichas: lo etiquetamos aparte (violeta).
function displayTipo(m: { tipo: string; billetera_delta: number; fichas_delta: number }): string {
  if (m.tipo === 'pago' && m.billetera_delta === 0 && m.fichas_delta > 0) return 'pago_agente';
  return m.tipo;
}

const btn = (bg: string, fg: string): React.CSSProperties => ({
  background: bg, color: fg, fontWeight: 700, fontSize: '13px', border: 'none',
  borderRadius: '10px', padding: '10px 18px', cursor: 'pointer',
});

export default function FichasClient() {
  const [data, setData]       = useState<Resumen | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');

  const [cargar, setCargar]   = useState('');
  const [busy, setBusy]       = useState(false);

  // ── Parte 4: controles manuales (overrides del agente) ──
  const [editStock, setEditStock]   = useState(false);
  const [stockVal,  setStockVal]    = useState('');
  const [editBillId, setEditBillId] = useState<string | null>(null);
  const [billVal,    setBillVal]    = useState('');
  const [resetOpen,  setResetOpen]  = useState(false);
  const [resetText,  setResetText]  = useState('');
  const [resetComps, setResetComps] = useState(false);

  // ── Etapa 5: descargas ──
  const [histPage, setHistPage]     = useState(0);
  // ── Etapa 6: cierres de turno ──
  const [cierrePage, setCierrePage] = useState(0);
  const [cierreOp, setCierreOp]     = useState('');   // filtro por operador (id)
  const [cierreFecha, setCierreFecha] = useState(''); // filtro por fecha (yyyy-mm-dd)

  async function fetchResumen() {
    try {
      const res = await fetch('/api/fichas');
      if (!res.ok) { setError(await res.text().catch(() => '') || 'No se pudo cargar la caja'); return; }
      setData(await res.json());
      setError('');
    } catch {
      setError('Error de red');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { fetchResumen(); }, []);

  async function post(payload: Record<string, any>): Promise<boolean> {
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/fichas', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      if (!res.ok) { setError(await res.text().catch(() => '') || 'No se pudo completar la acción'); return false; }
      await fetchResumen();
      return true;
    } catch {
      setError('Error de red');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function recargar() {
    const n = parseInt(cargar.replace(/\D/g, ''), 10);
    if (!Number.isInteger(n) || n <= 0) { setError('Ingresá una cantidad mayor a 0'); return; }
    const ok = await post({ action: 'recargar', cantidad: n });
    if (ok) setCargar('');
  }

  async function toggleCaja() {
    if (!data) return;
    await post({ action: 'set_caja_enabled', enabled: !data.caja_enabled });
  }

  // Avisa (no bloquea) si un override deja un valor en negativo.
  function confirmNegativo(label: string, val: number): boolean {
    if (val >= 0) return true;
    return window.confirm(`⚠️ Esto deja ${label} en ${fmt(val)} (NEGATIVO). ¿Seguro que querés continuar?`);
  }

  function parseEntero(s: string): number | null {
    const t = s.trim();
    if (t === '' || t === '-') return null;
    const n = parseInt(t, 10);
    return Number.isInteger(n) ? n : null;
  }

  async function saveStock() {
    const n = parseEntero(stockVal);
    if (n === null) { setError('Ingresá un número entero válido'); return; }
    if (!confirmNegativo('el stock', n)) return;
    const ok = await post({ action: 'set_stock', stock: n });
    if (ok) setEditStock(false);
  }

  async function saveBilletera(operadorId: string) {
    const n = parseEntero(billVal);
    if (n === null) { setError('Ingresá un número entero válido'); return; }
    if (!confirmNegativo('la billetera', n)) return;
    const ok = await post({ action: 'set_billetera', operadorId, saldo: n });
    if (ok) setEditBillId(null);
  }

  async function resetBilletera(operadorId: string, name: string) {
    if (!window.confirm(`Resetear la billetera de ${name} a 0?`)) return;
    await post({ action: 'reset_billetera', operadorId });
  }

  async function borrarMov(id: string) {
    if (!window.confirm('Borrar este movimiento y revertir su efecto en stock y billetera?')) return;
    await post({ action: 'borrar_movimiento', movimientoId: id });
  }

  // Verificar un pendiente: descarga (plata → tu billetera) o cierre de turno
  // (plata del origen → su destino). El backend mueve la plata recién acá.
  async function verificarPendiente(d: DescargaPend) {
    if (d.tipo === 'traspaso') {
      const dest = d.destino_name ? `a ${d.destino_name}` : 'al agente';
      if (!window.confirm(`Verificar el cierre de turno de ${d.operador_name} por $${fmt(d.monto)}? Se traspasará su saldo ${dest}.`)) return;
      await post({ action: 'verificar_traspaso', comprobanteId: d.id });
    } else {
      if (!window.confirm(`Verificar la descarga de ${d.operador_name} por $${fmt(d.monto)}? Se moverá de su billetera a la tuya.`)) return;
      await post({ action: 'verificar_descarga', comprobanteId: d.id });
    }
  }

  async function doResetTotal() {
    if (resetText !== 'RESET') { setError('Escribí RESET para confirmar'); return; }
    const extra = resetComps ? '\n\n⚠️ También se borrarán TODOS los comprobantes.' : '';
    if (!window.confirm(`Reset total de la caja: pozo a 0, billeteras a 0, borra movimientos y cierres.${extra}\n\n¿Confirmás?`)) return;
    const ok = await post({ action: 'reset_total', confirm: 'RESET', borrar_comprobantes: resetComps });
    if (ok) { setResetOpen(false); setResetText(''); setResetComps(false); }
  }

  if (loading) {
    return <p style={{ textAlign: 'center', color: '#999', fontSize: '14px', padding: '20px' }}>Cargando caja…</p>;
  }

  const enabled = !!data?.caja_enabled;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

      {error && (
        <div style={{ background: '#FFE5E5', color: '#CC3333', borderRadius: '10px', padding: '10px 14px', fontSize: '13px', fontWeight: 600 }}>
          {error}
        </div>
      )}

      {data?.degraded && (
        <div style={{ background: '#FFF6E0', color: '#9a6b00', borderRadius: '10px', padding: '10px 14px', fontSize: '13px', fontWeight: 600 }}>
          La caja no está inicializada en la base. Corré <code>supabase-caja-fichas.sql</code> en Supabase para empezar a usarla.
        </div>
      )}

      {/* Stock del pozo */}
      <div style={{ background: '#0a0a0a', borderRadius: '18px', padding: '24px 26px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' }}>
        <div>
          <p style={{ margin: 0, fontSize: '12px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#aaff00' }}>
            Stock del pozo
          </p>
          <p style={{ margin: '6px 0 0', fontSize: '44px', fontWeight: 900, color: '#fff', lineHeight: 1 }}>
            {fmt(data?.stock ?? 0)}
          </p>
          <p style={{ margin: '6px 0 0', fontSize: '12px', color: '#888' }}>
            fichas disponibles · billeteras: {fmt(data?.total_billeteras ?? 0)}
          </p>
          {/* Ajuste manual del stock (override del agente). */}
          {editStock ? (
            <div style={{ display: 'flex', gap: '6px', alignItems: 'center', marginTop: '10px' }}>
              <input
                type="number" step="1" value={stockVal}
                onChange={(e) => setStockVal(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') saveStock(); if (e.key === 'Escape') setEditStock(false); }}
                placeholder="nuevo stock" autoFocus
                style={{ width: '130px', padding: '6px 10px', border: '2px solid #555', borderRadius: '8px', fontSize: '13px', fontWeight: 700, outline: 'none', background: '#1a1a1a', color: '#fff' }}
              />
              <button onClick={saveStock} disabled={busy} style={{ ...btn('#C8FF00', '#000'), padding: '6px 12px' }}>OK</button>
              <button onClick={() => setEditStock(false)} style={{ ...btn('#3a3a3a', '#ccc'), padding: '6px 12px' }}>✕</button>
            </div>
          ) : (
            <button
              onClick={() => { setEditStock(true); setStockVal(String(data?.stock ?? 0)); }}
              style={{ ...btn('transparent', '#888'), padding: '4px 0', fontSize: '11px', textDecoration: 'underline' }}
            >
              ✎ Ajustar stock a mano
            </button>
          )}
        </div>

        {/* On/off de la caja */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '8px' }}>
          <span style={{
            fontSize: '12px', fontWeight: 800, padding: '4px 12px', borderRadius: '999px',
            background: enabled ? '#1a7a3a' : '#333', color: enabled ? '#C8FF00' : '#bbb',
          }}>
            {enabled ? '● Caja ACTIVA' : '○ Caja apagada'}
          </span>
          <button onClick={toggleCaja} disabled={busy} style={btn(enabled ? '#3a3a3a' : '#C8FF00', enabled ? '#fff' : '#000')}>
            {enabled ? 'Apagar caja' : 'Activar caja'}
          </button>
          <span style={{ fontSize: '11px', color: '#777', maxWidth: '220px', textAlign: 'right', lineHeight: 1.4 }}>
            {enabled
              ? 'Verificar una carga descuenta fichas del pozo.'
              : 'Apagada: verificar NO descuenta fichas (modo seguro).'}
          </span>
        </div>
      </div>

      {/* Cargar fichas al pozo */}
      <div style={{ background: '#fff', borderRadius: '16px', padding: '18px 20px', boxShadow: '0 2px 10px rgba(0,0,0,0.06)', display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <p style={{ margin: 0, fontSize: '15px', fontWeight: 800, color: '#111' }}>Cargar fichas</p>
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            type="number" min="1" step="1" value={cargar}
            onChange={(e) => setCargar(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') recargar(); }}
            placeholder="Cantidad de fichas"
            style={{ flex: 1, minWidth: '180px', padding: '10px 12px', border: '2px solid #eee', borderRadius: '10px', fontSize: '14px', fontWeight: 700, outline: 'none', background: '#F7F7F7' }}
          />
          <button onClick={recargar} disabled={busy} style={btn('#C8FF00', '#000')}>
            {busy ? '…' : '+ Sumar al pozo'}
          </button>
        </div>
      </div>

      {/* Billeteras por operador (con controles manuales del agente) */}
      {(data?.billeteras.length ?? 0) > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <p style={{ margin: 0, fontSize: '15px', fontWeight: 800, color: '#111' }}>Billeteras por operador</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {data!.billeteras.map((b) => {
              const editing = editBillId === b.operador_id;
              return (
                <div key={b.operador_id} style={{ background: '#fff', borderRadius: '12px', padding: '10px 14px', boxShadow: '0 1px 5px rgba(0,0,0,0.05)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '13px', fontWeight: 700, color: '#222' }}>
                    {b.name}
                    {b.role && b.role !== 'operator' && (
                      <span style={{ fontSize: '10px', fontWeight: 700, color: '#aaa', marginLeft: '6px', textTransform: 'uppercase' }}>{b.role}</span>
                    )}
                  </span>
                  {editing ? (
                    <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                      <input
                        type="number" step="1" value={billVal}
                        onChange={(e) => setBillVal(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') saveBilletera(b.operador_id); if (e.key === 'Escape') setEditBillId(null); }}
                        placeholder="nuevo saldo" autoFocus
                        style={{ width: '120px', padding: '5px 8px', border: '2px solid #C8FF00', borderRadius: '8px', fontSize: '13px', fontWeight: 700, outline: 'none', background: '#f9ffe0' }}
                      />
                      <button onClick={() => saveBilletera(b.operador_id)} disabled={busy} style={{ ...btn('#C8FF00', '#000'), padding: '5px 10px', fontSize: '12px' }}>OK</button>
                      <button onClick={() => setEditBillId(null)} style={{ ...btn('#F0F0F0', '#888'), padding: '5px 10px', fontSize: '12px' }}>✕</button>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                      <span style={{ fontSize: '15px', fontWeight: 800, color: b.saldo < 0 ? '#c0392b' : '#111' }}>{fmt(b.saldo)}</span>
                      <button onClick={() => { setEditBillId(b.operador_id); setBillVal(String(b.saldo)); }} style={{ ...btn('#F0F0F0', '#333'), padding: '4px 10px', fontSize: '11px' }}>Editar</button>
                      <button onClick={() => resetBilletera(b.operador_id, b.name)} style={{ ...btn('#FFF0F0', '#c0392b'), padding: '4px 10px', fontSize: '11px' }}>Reset 0</button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Descargas (Etapa 5) ───────────────────────────────────────────── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <p style={{ margin: 0, fontSize: '15px', fontWeight: 800, color: '#111' }}>Descargas</p>

        {/* Billetera del agente: lo que recibís por descargas verificadas. */}
        <div style={{ background: '#f0eaff', borderRadius: '14px', padding: '16px 18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
          <div>
            <p style={{ margin: 0, fontSize: '11px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#6b3fb0' }}>
              Tu billetera de agente
            </p>
            <p style={{ margin: '4px 0 0', fontSize: '30px', fontWeight: 900, color: '#4a2a80', lineHeight: 1 }}>
              {fmt(data?.mi_billetera_agente ?? 0)}
            </p>
          </div>
          <span style={{ fontSize: '11px', color: '#8a6ac0', maxWidth: '220px', textAlign: 'right', lineHeight: 1.4 }}>
            Acumula lo que los operadores te descargan al verificar.
          </span>
        </div>

        {/* Pendientes de verificar: descargas (Etapa 5) y cierres de turno (Etapa 6) */}
        <p style={{ margin: '4px 0 0', fontSize: '13px', fontWeight: 800, color: '#444' }}>Pendientes de verificar</p>
        {(data?.descargas_pendientes.length ?? 0) === 0 ? (
          <p style={{ color: '#bbb', fontSize: '13px', padding: '8px 0' }}>No hay descargas ni cierres pendientes.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {data!.descargas_pendientes.map((d) => {
              const ts = TIPO_STYLE[d.tipo] ?? TIPO_STYLE.descarga;
              return (
                <div key={d.id} style={{ background: '#fff', borderRadius: '12px', padding: '10px 14px', boxShadow: '0 1px 5px rgba(0,0,0,0.05)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '11px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.04em', padding: '3px 10px', borderRadius: '999px', background: ts.bg, color: ts.fg }}>
                      {d.tipo === 'traspaso' ? 'cierre' : 'descarga'}
                    </span>
                    <span style={{ fontSize: '14px', fontWeight: 800, color: '#111' }}>${fmt(d.monto)}</span>
                    <span style={{ fontSize: '12px', color: '#888' }}>{d.operador_name}</span>
                    {d.tipo === 'traspaso' && (
                      <span style={{ fontSize: '12px', color: '#888' }}>→ {d.destino_name ?? 'agente'}</span>
                    )}
                    <span style={{ fontSize: '12px', color: '#aaa' }}>{formatFecha(d.created_at)}</span>
                  </div>
                  <button onClick={() => verificarPendiente(d)} disabled={busy} style={btn('#C8FF00', '#000')}>
                    Verificar
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* Historial de descargas verificadas (paginado client-side) */}
        {(data?.descargas_historial.length ?? 0) > 0 && (() => {
          const hist  = data!.descargas_historial;
          const pages = Math.ceil(hist.length / HIST_PAGE);
          const page  = Math.min(histPage, pages - 1);
          const slice = hist.slice(page * HIST_PAGE, page * HIST_PAGE + HIST_PAGE);
          return (
            <>
              <p style={{ margin: '8px 0 0', fontSize: '13px', fontWeight: 800, color: '#444' }}>Verificadas</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                {slice.map((d) => (
                  <div key={d.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', padding: '8px 4px', borderBottom: '1px solid #f3f3f3', flexWrap: 'wrap' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
                      <span style={{ fontSize: '13px', fontWeight: 800, color: '#111' }}>${fmt(d.monto)}</span>
                      <span style={{ fontSize: '12px', color: '#666' }}>{d.operador_name}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '12px', color: '#999' }}>
                      <span>verificó {d.verificado_por}</span>
                      <span>{formatFecha(d.verificado_at)}</span>
                    </div>
                  </div>
                ))}
              </div>
              {pages > 1 && (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px', marginTop: '6px' }}>
                  <button onClick={() => setHistPage((p) => Math.max(0, p - 1))} disabled={page === 0} style={{ ...btn('#F0F0F0', '#555'), padding: '5px 12px', opacity: page === 0 ? 0.4 : 1 }}>←</button>
                  <span style={{ fontSize: '12px', color: '#888', fontWeight: 700 }}>{page + 1} / {pages}</span>
                  <button onClick={() => setHistPage((p) => Math.min(pages - 1, p + 1))} disabled={page >= pages - 1} style={{ ...btn('#F0F0F0', '#555'), padding: '5px 12px', opacity: page >= pages - 1 ? 0.4 : 1 }}>→</button>
                </div>
              )}
            </>
          );
        })()}
      </div>

      {/* ── Cierres de turno (Etapa 6) ─────────────────────────────────────── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <p style={{ margin: 0, fontSize: '15px', fontWeight: 800, color: '#111' }}>Cierres de turno</p>
        {(() => {
          const all = data?.cierres ?? [];
          // Operadores presentes en los cierres, para el filtro.
          const opsMap = new Map<string, string>();
          for (const c of all) opsMap.set(c.operador_id, c.operador_name);
          const ops = Array.from(opsMap.entries());

          // Filtro por operador y por fecha (yyyy-mm-dd sobre turno_fin_at en AR).
          const filtered = all.filter((c) => {
            if (cierreOp && c.operador_id !== cierreOp) return false;
            if (cierreFecha) {
              const f = new Date(c.turno_fin_at || c.created_at);
              const fStr = isNaN(f.getTime()) ? '' : new Date(f.getTime() - 3 * 3600_000).toISOString().slice(0, 10);
              if (fStr !== cierreFecha) return false;
            }
            return true;
          });
          const pages = Math.max(1, Math.ceil(filtered.length / HIST_PAGE));
          const page  = Math.min(cierrePage, pages - 1);
          const slice = filtered.slice(page * HIST_PAGE, page * HIST_PAGE + HIST_PAGE);

          return (
            <>
              {/* Filtros */}
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
                <select
                  value={cierreOp}
                  onChange={(e) => { setCierreOp(e.target.value); setCierrePage(0); }}
                  style={{ padding: '7px 10px', border: '2px solid #eee', borderRadius: '8px', fontSize: '12px', fontWeight: 700, background: '#F7F7F7', color: '#333' }}
                >
                  <option value="">Todos los operadores</option>
                  {ops.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
                </select>
                <input
                  type="date" value={cierreFecha}
                  onChange={(e) => { setCierreFecha(e.target.value); setCierrePage(0); }}
                  style={{ padding: '7px 10px', border: '2px solid #eee', borderRadius: '8px', fontSize: '12px', fontWeight: 700, background: '#F7F7F7', color: '#333' }}
                />
                {(cierreOp || cierreFecha) && (
                  <button onClick={() => { setCierreOp(''); setCierreFecha(''); setCierrePage(0); }} style={{ ...btn('#F0F0F0', '#666'), padding: '6px 12px', fontSize: '12px' }}>
                    Limpiar
                  </button>
                )}
              </div>

              {filtered.length === 0 ? (
                <p style={{ color: '#bbb', fontSize: '14px', padding: '10px 0' }}>No hay cierres para ese filtro.</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {slice.map((c) => (
                    <div key={c.id} style={{ background: '#fff', borderRadius: '12px', padding: '12px 14px', boxShadow: '0 1px 5px rgba(0,0,0,0.05)', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
                        <span style={{ fontSize: '14px', fontWeight: 800, color: '#111' }}>
                          {c.operador_name} <span style={{ color: '#888', fontWeight: 600 }}>→ {c.destino_name}</span>
                        </span>
                        <span style={{ fontSize: '12px', color: '#999' }}>{formatFecha(c.turno_fin_at || c.created_at)}</span>
                      </div>
                      <div style={{ display: 'flex', gap: '6px 14px', flexWrap: 'wrap', fontSize: '12px', color: '#555' }}>
                        <span style={{ color: TIPO_STYLE.carga.fg, fontWeight: 700 }}>cargas ${fmt(c.total_cargas)}</span>
                        <span style={{ color: TIPO_STYLE.pago.fg, fontWeight: 700 }}>pagos ${fmt(c.total_pagos)}</span>
                        <span style={{ color: TIPO_STYLE.descarga.fg, fontWeight: 700 }}>descargas ${fmt(c.total_descargas)}</span>
                        <span style={{ color: TIPO_STYLE.sueldo.fg, fontWeight: 700 }}>sueldo ${fmt(c.total_sueldo)}</span>
                        <span style={{ color: TIPO_STYLE.traspaso.fg, fontWeight: 800 }}>traspaso ${fmt(c.total_traspaso)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {pages > 1 && (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px', marginTop: '2px' }}>
                  <button onClick={() => setCierrePage((p) => Math.max(0, p - 1))} disabled={page === 0} style={{ ...btn('#F0F0F0', '#555'), padding: '5px 12px', opacity: page === 0 ? 0.4 : 1 }}>←</button>
                  <span style={{ fontSize: '12px', color: '#888', fontWeight: 700 }}>{page + 1} / {pages}</span>
                  <button onClick={() => setCierrePage((p) => Math.min(pages - 1, p + 1))} disabled={page >= pages - 1} style={{ ...btn('#F0F0F0', '#555'), padding: '5px 12px', opacity: page >= pages - 1 ? 0.4 : 1 }}>→</button>
                </div>
              )}
            </>
          );
        })()}
      </div>

      {/* Historial de movimientos */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <p style={{ margin: 0, fontSize: '15px', fontWeight: 800, color: '#111' }}>Movimientos recientes</p>
        {(data?.movimientos.length ?? 0) === 0 ? (
          <p style={{ color: '#bbb', fontSize: '14px', padding: '16px 0', textAlign: 'center' }}>Todavía no hay movimientos.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {data!.movimientos.map((m) => {
              const dt = displayTipo(m);
              const ts = TIPO_STYLE[dt] ?? { bg: '#eee', fg: '#555' };
              return (
                <div key={m.id} style={{ background: '#fff', borderRadius: '12px', padding: '10px 14px', boxShadow: '0 1px 5px rgba(0,0,0,0.05)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
                    <span style={{ fontSize: '11px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.04em', padding: '3px 10px', borderRadius: '999px', background: ts.bg, color: ts.fg }}>
                      {TIPO_LABEL[dt] ?? dt}
                    </span>
                    <span style={{ fontSize: '14px', fontWeight: 800, color: '#111' }}>${fmt(m.monto)}</span>
                    {!!m.bono && m.bono > 0 && (
                      <span style={{ fontSize: '12px', fontWeight: 700, color: '#7a5a00' }}>🎁 {fmt(m.bono)}</span>
                    )}
                    {m.editado && (
                      <span style={{ fontSize: '10px', fontWeight: 700, color: '#b58900', background: '#fff7e6', borderRadius: '6px', padding: '2px 6px' }}>editado</span>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '12px', color: '#888' }}>
                    <span style={{ color: m.fichas_delta < 0 ? '#c0392b' : m.fichas_delta > 0 ? '#1a7a3a' : '#aaa', fontWeight: 700 }}>
                      {m.fichas_delta > 0 ? '+' : ''}{fmt(m.fichas_delta)} fichas
                    </span>
                    <span>{m.operador_name}</span>
                    <span>{formatFecha(m.created_at)}</span>
                    <button
                      onClick={() => borrarMov(m.id)}
                      title="Borrar movimiento y revertir su efecto"
                      style={{ ...btn('transparent', '#c0392b'), padding: '2px 6px', fontSize: '14px', lineHeight: 1 }}
                    >
                      🗑
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── ZONA DE PELIGRO ──────────────────────────────────────────────── */}
      <div style={{ marginTop: '12px', border: '2px solid #f0b0b0', background: '#fff7f7', borderRadius: '16px', padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '16px' }}>⚠️</span>
          <h3 style={{ margin: 0, fontSize: '14px', fontWeight: 900, color: '#c0392b', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Zona de peligro
          </h3>
        </div>
        <p style={{ margin: 0, fontSize: '13px', color: '#a05050', lineHeight: 1.5 }}>
          El reset total pone el pozo en 0, todas las billeteras en 0 y borra movimientos y cierres de turno.
          Los comprobantes NO se borran salvo que tildes la opción. Esto no se puede deshacer.
        </p>

        {!resetOpen ? (
          <button onClick={() => setResetOpen(true)} style={{ ...btn('#c0392b', '#fff'), alignSelf: 'flex-start' }}>
            Reset total de la caja
          </button>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', background: '#fff', border: '1px solid #f0c0c0', borderRadius: '12px', padding: '14px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', fontWeight: 600, color: '#a05050' }}>
              <input type="checkbox" checked={resetComps} onChange={(e) => setResetComps(e.target.checked)} />
              Borrar también todos los comprobantes de prueba
            </label>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '13px', fontWeight: 700, color: '#333' }}>Escribí <b>RESET</b> para confirmar:</span>
              <input
                value={resetText}
                onChange={(e) => setResetText(e.target.value)}
                placeholder="RESET"
                style={{ width: '120px', padding: '8px 10px', border: '2px solid #c0392b', borderRadius: '8px', fontSize: '13px', fontWeight: 800, outline: 'none', letterSpacing: '0.1em' }}
              />
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                onClick={doResetTotal}
                disabled={busy || resetText !== 'RESET'}
                style={{ ...btn(resetText === 'RESET' ? '#c0392b' : '#e0a0a0', '#fff'), cursor: resetText === 'RESET' ? 'pointer' : 'not-allowed' }}
              >
                {busy ? '…' : 'Ejecutar reset total'}
              </button>
              <button onClick={() => { setResetOpen(false); setResetText(''); setResetComps(false); }} style={btn('#F0F0F0', '#666')}>
                Cancelar
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
