'use client';

import React, { useEffect, useRef, useState } from 'react';
import { getSupabaseBrowser } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';

// ─────────────────────────────────────────────────────────────────────────────
// Pantalla de Caja de fichas (solo admin/agent). Parte 2: stock del pozo,
// encender/apagar la caja, recargar fichas e historial de movimientos.
// Los controles manuales/destructivos del agente llegan en la Parte 4.
// ─────────────────────────────────────────────────────────────────────────────

type Billetera = {
  operador_id: string; name: string; role: string | null; saldo: number; turno_abierto: boolean;
  saldo_congelado: number; tiene_descarga_pendiente: boolean;
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
  ajuste:      { bg: '#eef1f4', fg: '#475569' },
};
const TIPO_LABEL: Record<string, string> = {
  carga: 'carga', pago: 'pago', sueldo: 'sueldo', descarga: 'descarga', pago_agente: 'pago agente', traspaso: 'traspaso', ajuste: 'ajuste',
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

// Header clickeable de una sección colapsable (título + badge + chevron).
const sectionHeaderBtn: React.CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer',
  display: 'flex', alignItems: 'center', gap: '8px', padding: 0, width: '100%',
};
const sectionBadge: React.CSSProperties = {
  fontSize: '11px', fontWeight: 800, background: '#C8FF00', color: '#000',
  borderRadius: '999px', padding: '2px 8px',
};

export default function FichasClient() {
  const [data, setData]       = useState<Resumen | null>(null);
  // tenant del usuario: filtra el postgres_changes de movimientos por tenant.
  const { agent } = useAuth();
  const tid = agent?.tenant_id ?? null;
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');

  // Saldo de fichas del agente en el casino (admin.celuapuestas.bond). Solo se
  // muestra en tenants con casino_deposit_enabled=true (lo decide el backend).
  const [casinoEnabled, setCasinoEnabled] = useState(false);
  const [casinoBalance, setCasinoBalance] = useState<number | null>(null);

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

  // ── P2: traspaso directo entre billeteras (monto arbitrario, instantáneo) ──
  const [traspasoOpen,    setTraspasoOpen]    = useState(false);
  const [traspasoOrigen,  setTraspasoOrigen]  = useState('');
  const [traspasoDestino, setTraspasoDestino] = useState('');
  const [traspasoMonto,   setTraspasoMonto]   = useState('');

  // ── Etapa 5: descargas ──
  const [histPage, setHistPage]     = useState(0);
  // ── Etapa 6: cierres de turno ──
  const [cierrePage, setCierrePage] = useState(0);
  const [cierreOp, setCierreOp]     = useState('');   // filtro por operador (id)
  const [cierreFecha, setCierreFecha] = useState(''); // filtro por fecha (yyyy-mm-dd)
  // Confirmación inline del botón Verificar de un pendiente (sin window.confirm
  // bloqueante): guarda el id del comprobante armado para confirmar.
  const [confirmVerifId, setConfirmVerifId] = useState<string | null>(null);

  // ── Secciones colapsables (solo layout; no afecta datos) ──
  const [showPendientes,  setShowPendientes]  = useState(true);
  const [showVerificadas, setShowVerificadas] = useState(false);
  const [showCierres,     setShowCierres]     = useState(false);
  const [showMovimientos, setShowMovimientos] = useState(false);
  // Para abrir "Pendientes" solo en la primera carga con datos.
  const initPendRef = useRef(false);

  async function fetchResumen() {
    try {
      const res = await fetch('/api/fichas');
      if (!res.ok) {
        const raw = await res.text().catch(() => '');
        // No mostramos el JSON crudo ni el detalle de "offline": mensaje limpio.
        const clean = (raw.toLowerCase().includes('offline') || raw.trim().startsWith('{'))
          ? '⚠ Casino sin conexión'
          : (raw || 'No se pudo cargar la caja');
        setError(clean);
        return;
      }
      setData(await res.json());
      setError('');
    } catch {
      setError('Error de red');
    } finally {
      setLoading(false);
    }
  }

  // Saldo del casino: best-effort, gateado por tenant en el backend. Se refresca
  // junto con el resumen (mismo poll + mismo INSERT en `movimientos`, que es lo
  // que se escribe al verificar una carga/pago).
  async function fetchCasinoBalance() {
    try {
      const res = await fetch('/api/casino/balance');
      if (!res.ok) return;
      const j = await res.json();
      setCasinoEnabled(!!j.enabled);
      if (j.enabled && typeof j.balance === 'number') setCasinoBalance(j.balance);
    } catch {}
  }

  useEffect(() => {
    fetchResumen();
    fetchCasinoBalance();
    // Poll de respaldo (antes Fichas solo cargaba al entrar) + realtime: todo
    // movimiento de caja escribe en `movimientos` y refresca pozo/billeteras
    // al instante. Si el canal no está disponible, el poll cubre igual.
    const refreshAll = () => { fetchResumen(); fetchCasinoBalance(); };
    // Poll de respaldo relajado a 30 s: la inmediatez la da el Broadcast de Fase 2.
    const t = setInterval(refreshAll, 30_000);

    // Fase 2: señal de movimiento (via AdminShell) → refresca pozo/billeteras/descargas al instante.
    const onMov = () => refreshAll();
    window.addEventListener('iris:movimiento-broadcast', onMov);

    const sb = getSupabaseBrowser();
    let ch: any = null;
    if (sb && tid) {
      ch = sb.channel('realtime-fichas')
        .on('postgres_changes' as any, { event: 'INSERT', schema: 'public', table: 'movimientos', filter: `tenant_id=eq.${tid}` }, refreshAll)
        .subscribe();
    }

    return () => {
      clearInterval(t);
      window.removeEventListener('iris:movimiento-broadcast', onMov);
      if (sb && ch) { try { sb.removeChannel(ch); } catch (err) { console.warn('[fichas realtime] removeChannel falló:', err); } }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tid]);

  // Abrir "Pendientes de verificar" automáticamente solo la PRIMERA vez que
  // llegan datos y hay pendientes. Después respetamos lo que toque el usuario
  // (no lo re-abrimos en cada poll).
  useEffect(() => {
    if (data && !initPendRef.current) {
      initPendRef.current = true;
      setShowPendientes((data.descargas_pendientes?.length ?? 0) > 0);
    }
  }, [data]);

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

  function abrirTraspaso() {
    setTraspasoOrigen(''); setTraspasoDestino(''); setTraspasoMonto('');
    setError('');
    setTraspasoOpen(true);
  }

  async function doTraspaso() {
    const n = parseInt(traspasoMonto.replace(/\D/g, ''), 10);
    if (!traspasoOrigen || !traspasoDestino) { setError('Elegí origen y destino'); return; }
    if (traspasoOrigen === traspasoDestino)  { setError('El origen y el destino deben ser distintos'); return; }
    if (!Number.isInteger(n) || n <= 0)      { setError('Ingresá un monto mayor a 0'); return; }
    const ok = await post({ action: 'traspaso_directo', origenId: traspasoOrigen, destinoId: traspasoDestino, monto: n });
    if (ok) setTraspasoOpen(false);
  }

  async function borrarMov(id: string) {
    if (!window.confirm('Borrar este movimiento y revertir su efecto en stock y billetera?')) return;
    await post({ action: 'borrar_movimiento', movimientoId: id });
  }

  // Ejecuta la verificación de un pendiente ya confirmado inline: descarga (plata
  // → tu billetera) o cierre de turno (acredita al destino). El backend mueve la
  // plata recién acá. El error, si falla, lo muestra `post` arriba (setError).
  async function ejecutarVerificacion(d: DescargaPend) {
    setConfirmVerifId(null);
    if (d.tipo === 'traspaso') {
      await post({ action: 'verificar_traspaso', comprobanteId: d.id });
    } else {
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

      {/* Saldo en el casino (admin.celuapuestas.bond) — sincronizado en vivo.
          Estilo distinto al pozo interno (degradé teal→índigo) para que quede
          claro que es plata del casino, no fichas internas. */}
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

      {/* Stock del pozo (interno de IRIS). Mutuamente excluyente con "Saldo
          casino": si el tenant tiene el casino activado se oculta el pozo y se
          muestra el saldo del casino en su lugar. */}
      {!casinoEnabled && (
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
      )}

      {/* Cargar fichas al pozo — solo en modo manual (casino desactivado). Con el
          casino activo, el saldo lo maneja el casino y no se recarga a mano. */}
      {!casinoEnabled && (
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
      )}

      {/* Operadores en turno: los que tienen el turno abierto, con su saldo, el
          congelado por descargas pendientes y un badge si tienen una sin verificar. */}
      {(data?.billeteras.some((b) => b.turno_abierto) ?? false) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <p style={{ margin: 0, fontSize: '15px', fontWeight: 800, color: '#111' }}>Operadores en turno</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {data!.billeteras.filter((b) => b.turno_abierto).map((b) => (
              <div key={b.operador_id} style={{ background: '#fff', borderRadius: '12px', padding: '10px 14px', boxShadow: '0 1px 5px rgba(0,0,0,0.05)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '13px', fontWeight: 700, color: '#222' }}>
                  <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#1a8a1a', display: 'inline-block', flexShrink: 0 }} />
                  {b.name}
                  {b.tiene_descarga_pendiente && (
                    <span style={{ fontSize: '10px', fontWeight: 800, color: '#d97706', background: '#fff3e0', borderRadius: '999px', padding: '2px 8px', textTransform: 'uppercase' }}>
                      descarga pendiente
                    </span>
                  )}
                </span>
                <span style={{ display: 'flex', gap: '14px', alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '12px', color: '#888' }}>
                    Disponible <b style={{ color: '#111' }}>{fmt(b.saldo - b.saldo_congelado)}</b>
                  </span>
                  {b.saldo_congelado > 0 && (
                    <span style={{ fontSize: '12px', color: '#888' }}>
                      Congelado <b style={{ color: '#d97706' }}>{fmt(b.saldo_congelado)}</b>
                    </span>
                  )}
                  <span style={{ fontSize: '15px', fontWeight: 800, color: b.saldo < 0 ? '#c0392b' : '#111' }}>{fmt(b.saldo)}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Billeteras por operador (cards compactas, 2 columnas en desktop) */}
      {(data?.billeteras.length ?? 0) > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
            <p style={{ margin: 0, fontSize: '15px', fontWeight: 800, color: '#111' }}>Billeteras por operador</p>
            {/* Traspaso directo: mueve un monto entre dos billeteras al instante.
                Solo con la caja encendida y al menos 2 billeteras. */}
            {data!.caja_enabled && (data?.billeteras.length ?? 0) >= 2 && (
              <button onClick={abrirTraspaso} disabled={busy} style={{ ...btn('#e6f4ff', '#1d6fb8'), padding: '7px 14px', fontSize: '12px' }}>
                🔄 Traspasar
              </button>
            )}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
            {data!.billeteras.map((b) => {
              const editing = editBillId === b.operador_id;
              return (
                <div key={b.operador_id} style={{
                  flex: '1 1 calc(50% - 5px)', minWidth: '160px', position: 'relative',
                  background: '#fff', borderRadius: '14px', padding: '14px 16px',
                  boxShadow: '0 1px 5px rgba(0,0,0,0.05)',
                  display: 'flex', flexDirection: 'column', gap: '6px',
                }}>
                  {/* Editar: ícono discreto arriba a la derecha */}
                  {!editing && (
                    <button
                      onClick={() => { setEditBillId(b.operador_id); setBillVal(String(b.saldo)); }}
                      title="Editar saldo"
                      style={{ position: 'absolute', top: '10px', right: '12px', background: 'none', border: 'none', cursor: 'pointer', fontSize: '11px', color: '#aaa', padding: 0, lineHeight: 1 }}
                    >
                      ✏
                    </button>
                  )}

                  <span style={{ fontSize: '12px', fontWeight: 700, color: '#888', textTransform: 'uppercase' }}>
                    {b.name}
                    {b.role && b.role !== 'operator' && (
                      <span style={{ fontSize: '10px', fontWeight: 700, color: '#bbb', marginLeft: '6px' }}>{b.role}</span>
                    )}
                  </span>

                  {editing ? (
                    <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                      <input
                        type="number" step="1" value={billVal}
                        onChange={(e) => setBillVal(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') saveBilletera(b.operador_id); if (e.key === 'Escape') setEditBillId(null); }}
                        placeholder="nuevo saldo" autoFocus
                        style={{ width: '110px', padding: '5px 8px', border: '2px solid #C8FF00', borderRadius: '8px', fontSize: '13px', fontWeight: 700, outline: 'none', background: '#f9ffe0' }}
                      />
                      <button onClick={() => saveBilletera(b.operador_id)} disabled={busy} style={{ ...btn('#C8FF00', '#000'), padding: '5px 10px', fontSize: '12px' }}>OK</button>
                      <button onClick={() => setEditBillId(null)} style={{ ...btn('#F0F0F0', '#888'), padding: '5px 10px', fontSize: '12px' }}>✕</button>
                    </div>
                  ) : (
                    <>
                      <span style={{ fontSize: '26px', fontWeight: 900, color: b.saldo < 0 ? '#c0392b' : '#111', lineHeight: 1 }}>{fmt(b.saldo)}</span>
                      {b.saldo > 0 && (
                        <button
                          onClick={() => resetBilletera(b.operador_id, b.name)}
                          style={{ alignSelf: 'flex-start', background: 'none', border: 'none', cursor: 'pointer', fontSize: '11px', color: '#c0392b', padding: 0 }}
                        >
                          Reset 0
                        </button>
                      )}
                    </>
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
        <button onClick={() => setShowPendientes((v) => !v)} style={sectionHeaderBtn}>
          <span style={{ fontSize: '15px', fontWeight: 800, color: '#111' }}>Pendientes de verificar</span>
          {(data?.descargas_pendientes.length ?? 0) > 0 && (
            <span style={sectionBadge}>{data!.descargas_pendientes.length}</span>
          )}
          <span style={{ fontSize: '12px', color: '#aaa', marginLeft: 'auto' }}>{showPendientes ? '▲' : '▼'}</span>
        </button>
        {showPendientes && ((data?.descargas_pendientes.length ?? 0) === 0 ? (
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
                  {confirmVerifId === d.id ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                      <span style={{ fontSize: '12px', fontWeight: 700, color: '#444' }}>
                        {d.tipo === 'traspaso'
                          ? `¿Verificar el cierre? Se acreditará ${d.destino_name ? `a ${d.destino_name}` : 'al agente'}.`
                          : '¿Verificar la descarga? Pasa a tu billetera.'}
                      </span>
                      <button onClick={() => ejecutarVerificacion(d)} disabled={busy} style={btn('#C8FF00', '#000')}>
                        {busy ? '…' : 'Sí'}
                      </button>
                      <button onClick={() => setConfirmVerifId(null)} disabled={busy} style={btn('#e0e0e0', '#333')}>
                        No
                      </button>
                    </div>
                  ) : (
                    <button onClick={() => setConfirmVerifId(d.id)} disabled={busy} style={btn('#C8FF00', '#000')}>
                      Verificar
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        ))}

        {/* Historial de descargas verificadas (paginado client-side) */}
        {(data?.descargas_historial.length ?? 0) > 0 && (() => {
          const hist  = data!.descargas_historial;
          const pages = Math.ceil(hist.length / HIST_PAGE);
          const page  = Math.min(histPage, pages - 1);
          const slice = hist.slice(page * HIST_PAGE, page * HIST_PAGE + HIST_PAGE);
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <button onClick={() => setShowVerificadas((v) => !v)} style={sectionHeaderBtn}>
                <span style={{ fontSize: '15px', fontWeight: 800, color: '#111' }}>Verificadas</span>
                <span style={sectionBadge}>{hist.length}</span>
                <span style={{ fontSize: '12px', color: '#aaa', marginLeft: 'auto' }}>{showVerificadas ? '▲' : '▼'}</span>
              </button>
              {showVerificadas && (<>
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
              )}
            </div>
          );
        })()}
      </div>

      {/* ── Cierres de turno (Etapa 6) ─────────────────────────────────────── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <button onClick={() => setShowCierres((v) => !v)} style={sectionHeaderBtn}>
          <span style={{ fontSize: '15px', fontWeight: 800, color: '#111' }}>Cierres de turno</span>
          {(data?.cierres.length ?? 0) > 0 && (
            <span style={sectionBadge}>{data!.cierres.length}</span>
          )}
          <span style={{ fontSize: '12px', color: '#aaa', marginLeft: 'auto' }}>{showCierres ? '▲' : '▼'}</span>
        </button>
        {showCierres && (() => {
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
        <button onClick={() => setShowMovimientos((v) => !v)} style={sectionHeaderBtn}>
          <span style={{ fontSize: '15px', fontWeight: 800, color: '#111' }}>Movimientos recientes</span>
          {(data?.movimientos.length ?? 0) > 0 && (
            <span style={sectionBadge}>{data!.movimientos.length}</span>
          )}
          <span style={{ fontSize: '12px', color: '#aaa', marginLeft: 'auto' }}>{showMovimientos ? '▲' : '▼'}</span>
        </button>
        {showMovimientos && ((data?.movimientos.length ?? 0) === 0 ? (
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
        ))}
      </div>

      {/* ── Reset total: acción discreta. El link gris expande el panel de
          confirmación que ya existía (checkbox + input RESET + botones). ── */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginTop: '4px' }}>
        {!resetOpen ? (
          <button
            onClick={() => setResetOpen(true)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '12px', color: '#aaa', textDecoration: 'underline', padding: '4px' }}
          >
            ⚠ Reset total de la caja
          </button>
        ) : (
          <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: '10px', background: '#fff', border: '1px solid #eee', borderRadius: '12px', padding: '16px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', fontWeight: 600, color: '#777' }}>
              <input type="checkbox" checked={resetComps} onChange={(e) => setResetComps(e.target.checked)} />
              Borrar también todos los comprobantes de prueba
            </label>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '13px', fontWeight: 700, color: '#333' }}>Escribí <b>RESET</b> para confirmar:</span>
              <input
                value={resetText}
                onChange={(e) => setResetText(e.target.value)}
                placeholder="RESET"
                style={{ width: '120px', padding: '8px 10px', border: '2px solid #ddd', borderRadius: '8px', fontSize: '13px', fontWeight: 800, outline: 'none', letterSpacing: '0.1em' }}
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

      {/* ── P2: modal de traspaso directo entre billeteras ───────────────────── */}
      {traspasoOpen && data && (
        <div
          onClick={() => { if (!busy) setTraspasoOpen(false); }}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}
        >
          <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: '16px', maxWidth: '400px', width: '100%', padding: '22px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <h3 style={{ margin: 0, fontSize: '17px', fontWeight: 800 }}>Traspasar entre billeteras</h3>
            <p style={{ margin: 0, fontSize: '13px', color: '#666', lineHeight: 1.5 }}>
              Mueve un monto de una billetera a otra al instante. No requiere verificación.
            </p>

            <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', fontWeight: 700, color: '#888' }}>
              DESDE
              <select
                value={traspasoOrigen}
                onChange={(e) => setTraspasoOrigen(e.target.value)}
                style={{ padding: '10px 12px', border: '2px solid #eee', borderRadius: '10px', fontSize: '14px', fontWeight: 700, outline: 'none', background: '#F7F7F7', color: '#222' }}
              >
                <option value="">Elegí el origen…</option>
                {data.billeteras.map((b) => (
                  <option key={b.operador_id} value={b.operador_id}>{b.name} — ${fmt(b.saldo)}</option>
                ))}
              </select>
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', fontWeight: 700, color: '#888' }}>
              HACIA
              <select
                value={traspasoDestino}
                onChange={(e) => setTraspasoDestino(e.target.value)}
                style={{ padding: '10px 12px', border: '2px solid #eee', borderRadius: '10px', fontSize: '14px', fontWeight: 700, outline: 'none', background: '#F7F7F7', color: '#222' }}
              >
                <option value="">Elegí el destino…</option>
                {data.billeteras.filter((b) => b.operador_id !== traspasoOrigen).map((b) => (
                  <option key={b.operador_id} value={b.operador_id}>{b.name} — ${fmt(b.saldo)}</option>
                ))}
              </select>
            </label>

            <input
              type="number" min="1" step="1" value={traspasoMonto}
              onChange={(e) => setTraspasoMonto(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') doTraspaso(); }}
              placeholder="Monto a traspasar"
              style={{ padding: '11px 13px', border: '2px solid #eee', borderRadius: '10px', fontSize: '15px', fontWeight: 700, outline: 'none', background: '#F7F7F7' }}
            />

            {error && <div style={{ background: '#FFE5E5', color: '#CC3333', borderRadius: '10px', padding: '10px 12px', fontSize: '13px', fontWeight: 600 }}>{error}</div>}

            <div style={{ display: 'flex', gap: '10px' }}>
              <button onClick={() => { if (!busy) setTraspasoOpen(false); }} disabled={busy} style={{ ...btn('#F0F0F0', '#666'), flex: 1 }}>Cancelar</button>
              <button onClick={doTraspaso} disabled={busy} style={{ ...btn('#1d6fb8', '#fff'), flex: 1 }}>{busy ? '…' : 'Traspasar'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
