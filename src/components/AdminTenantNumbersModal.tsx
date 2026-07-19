'use client';

import React, { useEffect, useState } from 'react';

// Modal admin de gestión de números de WhatsApp de UN cliente (tenant), abierto
// desde las tarjetas de /admin/tenants. Habla con /api/tenants/[id]/whatsapp-numbers
// (requireAdmin, scope por path). A diferencia del panel self-service del cliente,
// acá el admin tiene control total y además carga el app_secret (evita el 401).

export type AdminWaNumber = {
  id: string;
  label: string | null;
  phone_number_id: string;
  waba_id: string | null;
  active: boolean;
  is_default: boolean;
  created_at: string;
  has_token: boolean;
  has_app_secret: boolean;
};

// Salud de config de un cliente (para el punto de estado de la tarjeta). No es una
// verificación en vivo contra Meta (eso es el botón Verificar). Mismo criterio que
// el aviso del modal: solo hay riesgo de 401 cuando un número usa TOKEN PROPIO y le
// falta el app_secret (con token global el app_secret sale del env, no falta nada).
//   'n' = sin números
//   'y' = tiene números pero ninguno activo, o algún activo con token propio sin app_secret
//   'g' = tiene activos y ninguno en riesgo
export function numbersHealth(nums: AdminWaNumber[]): 'g' | 'y' | 'n' {
  if (!nums.length) return 'n';
  const actives = nums.filter((n) => n.active);
  if (actives.length === 0) return 'y';
  const atRisk = actives.some((n) => n.has_token && !n.has_app_secret);
  return atRisk ? 'y' : 'g';
}

const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(10,11,6,0.5)', zIndex: 990,
  display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '40px 16px', overflowY: 'auto',
};
const panel: React.CSSProperties = {
  background: '#fff', borderRadius: '20px', padding: '22px', width: '100%', maxWidth: '620px',
  display: 'flex', flexDirection: 'column', gap: '16px', boxShadow: '0 12px 48px rgba(0,0,0,0.25)',
};
const inputStyle: React.CSSProperties = {
  background: '#F5F5F5', border: '1px solid #eee', borderRadius: '9px',
  padding: '9px 11px', fontSize: '13.5px', color: '#000', outline: 'none', width: '100%', boxSizing: 'border-box',
};
const labelStyle: React.CSSProperties = {
  fontSize: '10.5px', fontWeight: 800, color: '#999', textTransform: 'uppercase', letterSpacing: '0.06em',
};
const badge: React.CSSProperties = {
  fontSize: '10px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em',
  padding: '2px 8px', borderRadius: '20px', whiteSpace: 'nowrap',
};
const mbtn: React.CSSProperties = {
  border: '1px solid #e0e0e0', background: '#fff', color: '#555', borderRadius: '8px',
  padding: '7px 11px', fontSize: '12px', fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap',
};
const actionBtn: React.CSSProperties = {
  border: 'none', borderRadius: '10px', padding: '8px 14px', fontSize: '12.5px', fontWeight: 800, cursor: 'pointer',
};

export default function AdminTenantNumbersModal({
  tenant, onClose, onChanged, onMembership, onAgent, onToggleStatus,
}: {
  tenant: { id: string; name: string; plan: string; status: string; max_whatsapp_numbers: number };
  onClose: () => void;
  onChanged: () => void;             // refrescar las tarjetas tras cualquier cambio
  onMembership: () => void;          // abrir modal de Membresía (donde está el cupo)
  onAgent: () => void;               // abrir modal de Agente
  onToggleStatus: () => Promise<void> | void; // Suspender/Activar inline
}) {
  const [numbers, setNumbers] = useState<AdminWaNumber[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState('');
  const [saving, setSaving] = useState(false);
  const [togglingStatus, setTogglingStatus] = useState(false);

  // Alta ("Agregar y verificar")
  const [showForm, setShowForm] = useState(false);
  const [fLabel, setFLabel] = useState('');
  const [fPid,   setFPid]   = useState('');
  const [fTok,   setFTok]   = useState('');
  const [fSec,   setFSec]   = useState('');
  const [fWaba,  setFWaba]  = useState('');

  // Edición inline
  const [editingId, setEditingId] = useState<string | null>(null);
  const [eLabel, setELabel] = useState('');
  const [eWaba,  setEWaba]  = useState('');
  const [eTok,   setETok]   = useState('');
  const [eSec,   setESec]   = useState('');

  // Menú (kebab) y verificación
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [verifying, setVerifying] = useState<string | null>(null);
  const [verifyResult, setVerifyResult] = useState<Record<string, { ok: boolean; text: string }>>({});

  const base = `/api/tenants/${tenant.id}/whatsapp-numbers`;

  async function fetchNumbers() {
    try {
      const res = await fetch(base);
      if (res.ok) setNumbers(await res.json());
      else setError(await res.text());
    } catch { setError('Error de red.'); }
    finally { setLoading(false); }
  }

  useEffect(() => { fetchNumbers(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [tenant.id]);

  async function refresh() { await fetchNumbers(); onChanged(); }

  async function patchNumber(id: string, payload: Record<string, unknown>): Promise<boolean> {
    setError('');
    try {
      const res = await fetch(base, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...payload }),
      });
      if (!res.ok) { setError(await res.text()); return false; }
      await refresh();
      return true;
    } catch { setError('Error de red.'); return false; }
  }

  async function verify(id: string) {
    setVerifying(id);
    setVerifyResult((p) => ({ ...p, [id]: undefined as any }));
    try {
      const res = await fetch(`${base}/verify`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
      });
      const d = await res.json().catch(() => null);
      if (res.ok && d?.ok) setVerifyResult((p) => ({ ...p, [id]: { ok: true, text: `✅ ${d.display_phone_number ?? 'OK'}` } }));
      else setVerifyResult((p) => ({ ...p, [id]: { ok: false, text: `❌ ${d?.error ?? 'Error verificando'}` } }));
    } catch { setVerifyResult((p) => ({ ...p, [id]: { ok: false, text: '❌ Error de red' } })); }
    finally { setVerifying(null); }
  }

  function startEdit(n: AdminWaNumber) {
    setEditingId(n.id); setOpenMenuId(null);
    setELabel(n.label ?? ''); setEWaba(n.waba_id ?? ''); setETok(''); setESec('');
    setError('');
  }

  async function saveEdit(n: AdminWaNumber) {
    // Token/app_secret: solo se mandan si se escribió uno nuevo (mandar vacío los borraría).
    const payload: Record<string, unknown> = { label: eLabel, waba_id: eWaba };
    if (eTok.trim()) payload.access_token = eTok.trim();
    if (eSec.trim()) payload.app_secret = eSec.trim();
    setSaving(true);
    const ok = await patchNumber(n.id, payload);
    setSaving(false);
    if (ok) setEditingId(null);
  }

  async function del(id: string) {
    setError('');
    try {
      const res = await fetch(base, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
      });
      if (!res.ok) { setError(await res.text()); return; }
      await refresh();
    } catch { setError('Error de red.'); }
  }

  function resetForm() {
    setShowForm(false);
    setFLabel(''); setFPid(''); setFTok(''); setFSec(''); setFWaba('');
  }

  // Alta + verificación en un gesto: POST y, si sale, Verificar el nuevo número.
  async function addAndVerify() {
    setError('');
    if (!fLabel.trim()) { setError('Completá el label.'); return; }
    if (!fPid.trim())   { setError('Completá el phone number ID.'); return; }
    setSaving(true);
    try {
      const res = await fetch(base, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: fLabel.trim(), phone_number_id: fPid.trim(),
          access_token: fTok.trim(), app_secret: fSec.trim(), waba_id: fWaba.trim(),
        }),
      });
      if (!res.ok) { setError(await res.text()); setSaving(false); return; }
      const created = await res.json().catch(() => null);
      resetForm();
      await refresh();
      if (created?.id) await verify(created.id);
    } catch { setError('Error de red.'); }
    finally { setSaving(false); }
  }

  const quota = { count: numbers.length, max: tenant.max_whatsapp_numbers, full: numbers.length >= tenant.max_whatsapp_numbers };
  // Solo hay riesgo de 401 cuando el número usa TOKEN PROPIO (app propia del cliente)
  // y no cargó su app_secret. Con token global, el app_secret sale del env global:
  // no falta nada, así que no se avisa.
  const missingSecret = numbers.filter((n) => n.active && n.has_token && !n.has_app_secret).length;
  const suspended = tenant.status === 'suspended';

  return (
    <div style={overlay} onClick={onClose}>
      <div style={panel} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '10px' }}>
          <div style={{ minWidth: 0 }}>
            <h2 style={{ fontSize: '19px', fontWeight: 900, color: '#000', margin: 0 }}>{tenant.name}</h2>
            <p style={{ fontSize: '12.5px', color: '#999', margin: '3px 0 0' }}>Membresía · plan {tenant.plan}</p>
          </div>
          <button onClick={onClose} aria-label="Cerrar" style={{ border: 'none', background: '#F0F0F0', color: '#666', borderRadius: '9px', width: 32, height: 32, fontSize: 16, cursor: 'pointer', flexShrink: 0 }}>✕</button>
        </div>

        {/* Acciones de cliente (lo que antes estaba en la tabla) */}
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <button onClick={onMembership} style={{ ...actionBtn, background: '#1a1a1a', color: '#C8FF00' }}>Membresía</button>
          <button onClick={onAgent} style={{ ...actionBtn, background: '#F0F0F0', color: '#333' }}>Agente</button>
          <button
            onClick={async () => { setTogglingStatus(true); await onToggleStatus(); setTogglingStatus(false); }}
            disabled={togglingStatus}
            style={{ ...actionBtn, background: suspended ? '#E7F9D5' : '#FFE0E0', color: suspended ? '#3F7A12' : '#C0392B', opacity: togglingStatus ? 0.6 : 1 }}
          >
            {togglingStatus ? '…' : suspended ? 'Activar' : 'Suspender'}
          </button>
        </div>

        {/* Sección Números */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', borderTop: '1px solid #f0f0f0', paddingTop: '14px' }}>
          <h3 style={{ margin: 0, fontSize: '11px', fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#999' }}>Números de WhatsApp</h3>
          <span style={{ fontSize: '12px', fontWeight: 800, color: quota.full ? '#9a6b00' : '#555', background: quota.full ? '#fff5da' : '#f5f5f5', border: `1px solid ${quota.full ? '#e6c15a' : '#eaeaea'}`, borderRadius: '8px', padding: '4px 9px', fontVariantNumeric: 'tabular-nums' }}>
            {quota.count} / {quota.max}
          </span>
        </div>

        {error && <p style={{ fontSize: '13px', color: '#E53935', fontWeight: 600, margin: 0 }}>{error}</p>}

        {missingSecret > 0 && (
          <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', background: '#fff5da', color: '#9a6b00', borderRadius: '10px', padding: '9px 11px', fontSize: '12px', fontWeight: 600 }}>
            <span>⚠️</span>
            <span>{missingSecret} número{missingSecret > 1 ? 's' : ''} sin <b>app_secret</b>: sus webhooks pueden fallar con 401 “Firma inválida”. Cargalo con Editar.</span>
          </div>
        )}

        {loading && <p style={{ color: '#999', fontSize: '13px', margin: 0 }}>Cargando números…</p>}
        {!loading && numbers.length === 0 && <p style={{ color: '#bbb', fontSize: '13px', margin: 0, fontStyle: 'italic' }}>Sin números conectados.</p>}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {numbers.map((n) => {
            const vr = verifyResult[n.id];
            const isEditing = editingId === n.id;
            const menuOpen = openMenuId === n.id;
            return (
              <div key={n.id} style={{ background: '#F8F8F8', border: '1px solid #eee', borderRadius: '14px', padding: '13px 14px' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '10px' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                      <b style={{ fontSize: '15px', fontWeight: 800, color: '#000' }}>{n.label ?? '(sin label)'}</b>
                      {n.is_default && <span style={{ ...badge, background: '#1a1a1a', color: '#C8FF00' }}>★ Default</span>}
                      <span style={{ ...badge, ...(n.active ? { background: '#e8fff0', color: '#1a7a3a', border: '1px solid #5ad87a' } : { background: '#eceded', color: '#97998c', border: '1px solid #e4e5df' }) }}>
                        {n.active ? 'Activo' : 'Inactivo'}
                      </span>
                    </div>
                    <div style={{ fontFamily: 'monospace', fontSize: '11.5px', color: '#97998c', margin: '5px 0 0' }}>{n.phone_number_id}</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px', marginTop: '8px', fontSize: '11.5px', color: '#5a5c52' }}>
                      <span>token {n.has_token ? <span style={{ color: '#1a7a3a' }}>cifrado ✔</span> : 'global (env)'}</span>
                      <span>app_secret {n.has_app_secret ? <span style={{ color: '#1a7a3a' }}>✔</span> : n.has_token ? <span style={{ color: '#9a6b00', fontWeight: 800 }}>— falta</span> : 'global (env)'}</span>
                      <span>WABA {n.waba_id ? <span style={{ color: '#1a7a3a' }}>✔</span> : '—'}</span>
                    </div>
                  </div>
                  <button onClick={() => setOpenMenuId(menuOpen ? null : n.id)} aria-label="Acciones" style={{ border: 'none', background: 'transparent', color: '#97998c', fontSize: '20px', cursor: 'pointer', width: 32, height: 28, borderRadius: 8, flexShrink: 0 }}>⋯</button>
                </div>

                {vr && <p style={{ fontSize: '12.5px', fontWeight: 700, margin: '10px 0 0', color: vr.ok ? '#1a7a3a' : '#E53935' }}>{vr.text}</p>}
                {verifying === n.id && <p style={{ fontSize: '12.5px', fontWeight: 700, margin: '10px 0 0', color: '#555' }}>⏳ Verificando contra Meta…</p>}

                {menuOpen && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '11px', paddingTop: '11px', borderTop: '1px dashed #e4e5df' }}>
                    <button onClick={() => verify(n.id)} disabled={verifying === n.id} style={mbtn}>Verificar</button>
                    <button onClick={() => startEdit(n)} style={mbtn}>Editar</button>
                    {!n.is_default && n.active && <button onClick={() => patchNumber(n.id, { make_default: true })} style={{ ...mbtn, background: '#1a1a1a', color: '#C8FF00', border: '1px solid #1a1a1a' }}>Hacer default</button>}
                    {!n.is_default && n.active && <button onClick={() => patchNumber(n.id, { active: false })} style={mbtn}>Desactivar</button>}
                    {!n.active && <button onClick={() => patchNumber(n.id, { active: true })} style={{ ...mbtn, background: '#C8FF00', color: '#000', border: '1px solid #C8FF00' }}>Activar</button>}
                    {!n.is_default && <button onClick={() => del(n.id)} style={{ ...mbtn, color: '#d33', borderColor: '#f0b0b0' }}>Eliminar</button>}
                  </div>
                )}

                {isEditing && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '11px', paddingTop: '11px', borderTop: '1px solid #eee' }}>
                    <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', flex: 1, minWidth: '150px' }}>
                        <label style={labelStyle}>Label</label>
                        <input value={eLabel} onChange={(e) => setELabel(e.target.value)} style={inputStyle} />
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', flex: 1, minWidth: '150px' }}>
                        <label style={labelStyle}>WABA ID</label>
                        <input value={eWaba} onChange={(e) => setEWaba(e.target.value)} placeholder="(vacío = global)" style={inputStyle} />
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', flex: 1, minWidth: '150px' }}>
                        <label style={labelStyle}>Access token</label>
                        <input type="password" value={eTok} onChange={(e) => setETok(e.target.value)} placeholder={n.has_token ? '•••••• (vacío = sin cambio)' : '(vacío = token global)'} style={inputStyle} />
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', flex: 1, minWidth: '150px' }}>
                        <label style={labelStyle}>App secret</label>
                        <input type="password" value={eSec} onChange={(e) => setESec(e.target.value)} placeholder={n.has_app_secret ? '•••••• (vacío = sin cambio)' : 'evita el 401'} style={inputStyle} />
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <button onClick={() => saveEdit(n)} disabled={saving} style={{ ...actionBtn, background: saving ? '#e0e0e0' : '#C8FF00', color: '#000' }}>{saving ? 'Guardando…' : 'Guardar cambios'}</button>
                      <button onClick={() => setEditingId(null)} style={{ ...mbtn, padding: '8px 14px' }}>Cancelar</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Alta */}
        {!showForm ? (
          <div>
            <button
              onClick={() => { setShowForm(true); setError(''); }}
              disabled={quota.full}
              style={{ width: '100%', border: '1px dashed #d8d8d8', background: 'transparent', color: quota.full ? '#bbb' : '#5a5c52', borderRadius: '12px', padding: '12px', fontSize: '13px', fontWeight: 800, cursor: quota.full ? 'not-allowed' : 'pointer' }}
            >
              + Agregar número
            </button>
            {quota.full && <p style={{ fontSize: '11.5px', color: '#97998c', textAlign: 'center', margin: '6px 0 0' }}>Cupo alcanzado ({quota.max}). Subilo en Membresía.</p>}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '11px', background: '#F8F8F8', border: '1px solid #eee', borderRadius: '14px', padding: '15px' }}>
            <h4 style={{ margin: 0, fontSize: '13.5px', fontWeight: 800, color: '#000' }}>Nuevo número</h4>
            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', flex: 1, minWidth: '150px' }}>
                <label style={labelStyle}>Nombre (label)</label>
                <input value={fLabel} onChange={(e) => setFLabel(e.target.value)} placeholder="Ej: Línea 2" style={inputStyle} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', flex: 1, minWidth: '150px' }}>
                <label style={labelStyle}>Phone number ID (Meta)</label>
                <input value={fPid} onChange={(e) => setFPid(e.target.value)} placeholder="113564937…" style={{ ...inputStyle, fontFamily: 'monospace' }} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', flex: 1, minWidth: '150px' }}>
                <label style={labelStyle}>Access token</label>
                <input type="password" value={fTok} onChange={(e) => setFTok(e.target.value)} placeholder="EAAG…" style={inputStyle} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', flex: 1, minWidth: '150px' }}>
                <label style={labelStyle}>App secret <span style={{ fontWeight: 500, textTransform: 'none', letterSpacing: 0, color: '#bbb' }}>· evita el 401</span></label>
                <input type="password" value={fSec} onChange={(e) => setFSec(e.target.value)} placeholder="a1b2c3…" style={inputStyle} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', flex: 1, minWidth: '150px' }}>
                <label style={labelStyle}>WABA ID <span style={{ fontWeight: 500, textTransform: 'none', letterSpacing: 0, color: '#bbb' }}>(opcional)</span></label>
                <input value={fWaba} onChange={(e) => setFWaba(e.target.value)} placeholder="(vacío = global)" style={{ ...inputStyle, fontFamily: 'monospace' }} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <button onClick={addAndVerify} disabled={saving} style={{ ...actionBtn, background: saving ? '#e0e0e0' : '#C8FF00', color: '#000', padding: '10px 18px' }}>{saving ? 'Agregando…' : 'Agregar y verificar'}</button>
              <button onClick={resetForm} style={{ ...mbtn, padding: '10px 14px' }}>Cancelar</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
