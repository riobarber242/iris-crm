'use client';

import React, { useEffect, useState } from 'react';
import OnboardingWizard from './OnboardingWizard';
import AdminTenantNumbersModal, { AdminWaNumber, numbersHealth } from './AdminTenantNumbersModal';

type Tenant = {
  id: string;
  name: string;
  whatsapp_phone_id: string | null;
  whatsapp_access_token: string | null;
  whatsapp_waba_id: string | null;
  whatsapp_display_number: string | null;
  created_at: string;
  username: string | null;
  system_prompt: string;
  // Membresía
  plan: string;
  status: string;
  monthly_amount: number;
  trial_ends_at: string | null;
  paid_until: string | null;
  skin: string;
  notes: string | null;
  max_whatsapp_numbers: number;
};

const MAX_PROMPT = 4000;

const PLAN_OPTIONS   = ['trial', 'basic', 'premium'];
const STATUS_OPTIONS = ['active', 'suspended', 'cancelled'];
const SKIN_OPTIONS   = ['casino', 'loteria', 'barberia'];

const SKIN_LABEL: Record<string, string> = { casino: 'Casino', loteria: 'Lotería', barberia: 'Barbería' };
const PLAN_LABEL: Record<string, string> = { trial: 'Trial', basic: 'Basic', premium: 'Premium' };

// Badge de estado: mezcla status + plan. Trial (ámbar) cuando está activo en
// período de prueba; Activo (verde) si paga; Suspendido (rojo); Cancelado (gris).
function statusBadge(t: Tenant): { label: string; bg: string; fg: string } {
  if (t.status === 'suspended') return { label: 'Suspendido', bg: '#FFE0E0', fg: '#C0392B' };
  if (t.status === 'cancelled') return { label: 'Cancelado', bg: '#E0E0E0', fg: '#555' };
  if (t.plan === 'trial')       return { label: 'Trial', bg: '#FFF3D6', fg: '#B8860B' };
  return { label: 'Activo', bg: '#E7F9D5', fg: '#3F7A12' };
}


const inputStyle: React.CSSProperties = {
  background: '#F5F5F5', border: '2px solid #eee', borderRadius: '10px',
  padding: '10px 12px', fontSize: '14px', color: '#1a1a1a', outline: 'none', width: '100%',
};
const btn = (bg: string, fg: string): React.CSSProperties => ({
  background: bg, color: fg, fontWeight: 700, fontSize: '13px', border: 'none',
  borderRadius: '10px', padding: '10px 18px', cursor: 'pointer',
});

// Generador de contraseña legible (sin caracteres ambiguos), browser-safe.
function generatePassword(len = 12): string {
  const charset = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const arr = new Uint32Array(len);
  crypto.getRandomValues(arr);
  return Array.from(arr, n => charset[n % charset.length]).join('');
}

export default function TenantsClient() {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');

  // modal de edición de agente (WhatsApp / prompt / password)
  const [editing, setEditing] = useState<Tenant | null>(null);
  // modal de edición de membresía (plan / status / monto / paga hasta / skin / notas)
  const [editingMembership, setEditingMembership] = useState<Tenant | null>(null);

  // wizard de alta guiada
  const [wizardOpen, setWizardOpen] = useState(false);

  // Números de WhatsApp por tenant (para los chips/cupo/estado de cada tarjeta) y
  // el tenant cuyo modal de gestión está abierto. Guardamos el ID (no el objeto)
  // para que el modal siempre lea el tenant fresco tras refrescar (status/cupo).
  const [numbersByTenant, setNumbersByTenant] = useState<Record<string, AdminWaNumber[]>>({});
  const [openTenantId, setOpenTenantId] = useState<string | null>(null);

  async function fetchAllNumbers(list: Tenant[]) {
    const entries = await Promise.all(list.map(async (t) => {
      try {
        const res = await fetch(`/api/tenants/${t.id}/whatsapp-numbers`);
        return [t.id, res.ok ? await res.json() : []] as const;
      } catch { return [t.id, [] as AdminWaNumber[]] as const; }
    }));
    setNumbersByTenant(Object.fromEntries(entries));
  }

  async function fetchTenants() {
    try {
      const res = await fetch('/api/tenants');
      if (res.ok) {
        const data = await res.json();
        setTenants(data);
        fetchAllNumbers(data);
      } else {
        setError((await res.json().catch(() => ({}))).error ?? 'Error cargando tenants');
      }
    } catch { setError('Error de red'); }
    finally { setLoading(false); }
  }

  useEffect(() => { fetchTenants(); }, []);

  const openTenant = tenants.find((t) => t.id === openTenantId) ?? null;

  // Suspender / Activar: toggle directo de status (el spinner lo maneja quien llama).
  async function toggleStatus(t: Tenant) {
    const next = t.status === 'suspended' ? 'active' : 'suspended';
    setError('');
    try {
      const res = await fetch(`/api/tenants/${t.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: next }),
      });
      if (res.ok) await fetchTenants();
      else setError((await res.json().catch(() => ({}))).error ?? 'No se pudo cambiar el estado');
    } catch { setError('Error de red'); }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

      {wizardOpen && (
        <OnboardingWizard onClose={() => setWizardOpen(false)} onCreated={fetchTenants} />
      )}

      {editing && (
        <EditTenantModal
          tenant={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); fetchTenants(); }}
        />
      )}

      {editingMembership && (
        <EditMembershipModal
          tenant={editingMembership}
          onClose={() => setEditingMembership(null)}
          onSaved={() => { setEditingMembership(null); fetchTenants(); }}
        />
      )}

      {/* Alta guiada: crea tenant + usuario + system prompt + operadores de una. */}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button onClick={() => setWizardOpen(true)} style={{ ...btn('#0a0a0a', '#C8FF00'), padding: '12px 22px', fontSize: '14px' }}>
          + Nuevo cliente
        </button>
      </div>

      {error && (
        <div style={{ background: '#FFE5E5', color: '#CC3333', borderRadius: '10px', padding: '10px 14px', fontSize: '13px', fontWeight: 600 }}>
          {error}
        </div>
      )}

      {/* Leyenda del punto de estado (salud de config, no verificación en vivo) */}
      {!loading && tenants.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px 18px', fontSize: '12px', color: '#777' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}><span style={{ width: 9, height: 9, borderRadius: '50%', background: '#5ad87a' }} /> Con app_secret OK</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}><span style={{ width: 9, height: 9, borderRadius: '50%', background: '#e6a700' }} /> Falta app_secret / inactivo</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}><span style={{ width: 9, height: 9, borderRadius: '50%', background: '#bbb' }} /> Sin números</span>
        </div>
      )}

      {/* Tarjetas por cliente. Tocar una abre el modal unificado (membresía + números). */}
      {loading ? (
        <p style={{ textAlign: 'center', color: '#999', fontSize: '14px' }}>Cargando clientes…</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {tenants.map((t) => {
            const nums = numbersByTenant[t.id] ?? [];
            const health = numbersHealth(nums);
            const dotColor = health === 'g' ? '#5ad87a' : health === 'y' ? '#e6a700' : '#bbb';
            const dotRing  = health === 'g' ? '#e8fff0' : health === 'y' ? '#fff5da' : '#eee';
            const full = nums.length >= t.max_whatsapp_numbers;
            return (
              <button
                key={t.id}
                onClick={() => setOpenTenantId(t.id)}
                style={{
                  textAlign: 'left', width: '100%', font: 'inherit', color: 'inherit', cursor: 'pointer',
                  background: '#fff', border: '1px solid #e4e5df', borderRadius: '16px', padding: '16px',
                  boxShadow: '0 1px 6px rgba(0,0,0,0.05)', display: 'flex', flexDirection: 'column', gap: '12px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '9px', minWidth: 0 }}>
                    <span style={{ width: 11, height: 11, borderRadius: '50%', background: dotColor, boxShadow: `0 0 0 3px ${dotRing}`, flexShrink: 0 }} />
                    <span style={{ display: 'flex', flexDirection: 'column', gap: '1px', minWidth: 0 }}>
                      <b style={{ fontSize: '16px', fontWeight: 800, color: '#111', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.name}</b>
                      {t.username && <span style={{ fontSize: '11px', color: '#aaa', fontFamily: 'monospace' }}>{t.username}</span>}
                    </span>
                  </span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
                    <span style={{ fontSize: '10px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.06em', padding: '3px 8px', borderRadius: '20px', background: '#f5f5f5', color: '#777', border: '1px solid #eaeaea' }}>{PLAN_LABEL[t.plan] ?? t.plan}</span>
                    {(() => { const b = statusBadge(t); return <span style={{ fontSize: '10px', fontWeight: 800, borderRadius: '20px', padding: '3px 8px', background: b.bg, color: b.fg }}>{b.label}</span>; })()}
                  </span>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', flex: 1, minWidth: 0 }}>
                    {nums.length === 0 ? (
                      <span style={{ fontSize: '12.5px', color: '#bbb', fontStyle: 'italic' }}>Sin números conectados</span>
                    ) : nums.map((n) => (
                      <span key={n.id} style={{
                        display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '12px', fontWeight: 700,
                        padding: '4px 10px', borderRadius: '20px', whiteSpace: 'nowrap',
                        ...(n.is_default ? { background: '#1a1a1a', color: '#C8FF00', border: '1px solid #1a1a1a' } : { background: '#f5f5f5', color: '#333', border: '1px solid #eaeaea' }),
                        ...(n.active ? {} : { color: '#aaa', textDecoration: 'line-through' }),
                      }}>
                        {n.is_default && <span style={{ fontSize: '11px' }}>★</span>}
                        {n.label ?? '(sin label)'}
                      </span>
                    ))}
                  </div>
                  <span style={{ fontSize: '12px', fontWeight: 800, color: full ? '#9a6b00' : '#777', background: full ? '#fff5da' : '#f5f5f5', border: `1px solid ${full ? '#e6c15a' : '#eaeaea'}`, borderRadius: '8px', padding: '4px 9px', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                    {nums.length} / {t.max_whatsapp_numbers}
                  </span>
                  <span style={{ color: '#bbb', fontSize: '18px', flexShrink: 0 }}>›</span>
                </div>
              </button>
            );
          })}

          {tenants.length === 0 && (
            <p style={{ textAlign: 'center', color: '#bbb', fontSize: '14px', padding: '20px 0' }}>No hay clientes todavía.</p>
          )}
        </div>
      )}

      {/* Modal unificado: membresía/agente/suspender + números del cliente. */}
      {openTenant && (
        <AdminTenantNumbersModal
          tenant={openTenant}
          onClose={() => setOpenTenantId(null)}
          onChanged={() => fetchAllNumbers(tenants)}
          onMembership={() => { const t = openTenant; setOpenTenantId(null); setEditingMembership(t); }}
          onAgent={() => { const t = openTenant; setOpenTenantId(null); setEditing(t); }}
          onToggleStatus={() => toggleStatus(openTenant)}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Modal de edición de un agente ya creado. Permite editar todo sin ir a Supabase:
// datos básicos, WhatsApp, system prompt y reseteo de contraseña del agente.
// ─────────────────────────────────────────────────────────────────────────────
function EditTenantModal({ tenant, onClose, onSaved }: { tenant: Tenant; onClose: () => void; onSaved: () => void }) {
  const [name,     setName]     = useState(tenant.name);
  const [prompt,   setPrompt]   = useState(tenant.system_prompt ?? '');
  const [password, setPassword] = useState('');
  const [showPw,   setShowPw]   = useState(false);

  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!name.trim()) { setError('El nombre no puede quedar vacío.'); return; }
    if (prompt.length > MAX_PROMPT) { setError(`El system prompt supera ${MAX_PROMPT} caracteres.`); return; }
    if (password && password.length < 6) { setError('La contraseña debe tener al menos 6 caracteres.'); return; }

    setError('');
    setSaving(true);
    try {
      const body: Record<string, any> = {
        name: name.trim(),
        system_prompt: prompt,
      };
      if (password) body.nueva_password = password;

      const res = await fetch(`/api/tenants/${tenant.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok) onSaved();
      else setError(d.error ?? 'No se pudo guardar');
    } catch {
      setError('Error de red');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={overlay} onClick={onClose}>
      <div style={panel} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <h2 style={{ fontSize: '20px', fontWeight: 900, color: '#000', margin: 0 }}>Editar cliente</h2>
            <p style={{ fontSize: '13px', color: '#999', margin: '4px 0 0' }}>{tenant.name}{tenant.username ? ` · ${tenant.username}` : ''}</p>
          </div>
          <button onClick={onClose} style={{ ...btn('#F0F0F0', '#666'), padding: '6px 12px' }}>✕</button>
        </div>

        {error && (
          <div style={{ background: '#FFE5E5', color: '#CC3333', borderRadius: '10px', padding: '10px 14px', fontSize: '13px', fontWeight: 600 }}>
            {error}
          </div>
        )}

        {/* Sección 1 — Datos básicos */}
        <Section title="Datos básicos">
          <Field label="Nombre del negocio">
            <input style={inputStyle} value={name} onChange={e => setName(e.target.value)} />
          </Field>
        </Section>

        {/* Los números de WhatsApp (con token/app_secret cifrados) se cargan desde
            la sección "Números de WhatsApp" del modal del cliente, no acá. */}

        {/* Sección 2 — Bot */}
        <Section title="Bot">
          <Field label="System Prompt">
            <textarea
              style={{ ...inputStyle, minHeight: '160px', resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }}
              value={prompt}
              maxLength={MAX_PROMPT}
              onChange={e => setPrompt(e.target.value)}
            />
            <span style={{ alignSelf: 'flex-end', fontSize: '11px', fontWeight: 700, color: prompt.length > MAX_PROMPT ? '#CC3333' : '#bbb' }}>
              {prompt.length} / {MAX_PROMPT}
            </span>
          </Field>
        </Section>

        {/* Sección 4 — Acceso */}
        <Section title="Acceso">
          <Field label="Nueva contraseña (dejar vacío = no cambia)">
            <div style={{ display: 'flex', gap: '8px' }}>
              <input style={inputStyle} type={showPw ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••" />
              <button type="button" onClick={() => setShowPw(s => !s)} style={{ ...btn('#EEE', '#333'), padding: '10px 12px', whiteSpace: 'nowrap' }}>{showPw ? 'Ocultar' : 'Ver'}</button>
              <button type="button" onClick={() => { setPassword(generatePassword()); setShowPw(true); }} style={{ ...btn('#1a1a1a', '#C8FF00'), padding: '10px 12px', whiteSpace: 'nowrap' }}>Generar</button>
            </div>
          </Field>
        </Section>

        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px' }}>
          <button onClick={onClose} style={btn('#F0F0F0', '#666')}>Cancelar</button>
          <button onClick={save} disabled={saving} style={btn('#C8FF00', '#000')}>
            {saving ? 'Guardando…' : 'Guardar cambios'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Modal de edición de la MEMBRESÍA del tenant: plan, estado, monto mensual,
// fecha "paga hasta", skin y notas internas. Escribe en columnas de `tenants`.
// ─────────────────────────────────────────────────────────────────────────────
function EditMembershipModal({ tenant, onClose, onSaved }: { tenant: Tenant; onClose: () => void; onSaved: () => void }) {
  const [plan,    setPlan]    = useState(tenant.plan ?? 'trial');
  const [status,  setStatus]  = useState(tenant.status ?? 'active');
  const [amount,  setAmount]  = useState(String(tenant.monthly_amount ?? 0));
  // paid_until: el input type=date trabaja con YYYY-MM-DD; recortamos el ISO.
  const [paidUntil, setPaidUntil] = useState((tenant.paid_until ?? '').slice(0, 10));
  const [skin,    setSkin]    = useState(tenant.skin ?? 'casino');
  const [notes,   setNotes]   = useState(tenant.notes ?? '');
  const [maxNumbers, setMaxNumbers] = useState(String(tenant.max_whatsapp_numbers ?? 2));

  const [error, setError]   = useState('');
  const [saving, setSaving] = useState(false);

  async function save() {
    const amountNum = Math.trunc(Number(amount));
    if (!Number.isFinite(amountNum) || amountNum < 0) { setError('El monto mensual debe ser un entero ≥ 0.'); return; }
    const maxNum = Math.trunc(Number(maxNumbers));
    if (!Number.isFinite(maxNum) || maxNum < 1) { setError('El cupo de números debe ser un entero ≥ 1.'); return; }

    setError('');
    setSaving(true);
    try {
      const body = {
        plan, status, skin,
        monthly_amount: amountNum,
        paid_until: paidUntil || '',   // vacío → el backend lo guarda como null
        notes,
        max_whatsapp_numbers: maxNum,
      };
      const res = await fetch(`/api/tenants/${tenant.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok) onSaved();
      else setError(d.error ?? 'No se pudo guardar');
    } catch {
      setError('Error de red');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={overlay} onClick={onClose}>
      <div style={panel} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <h2 style={{ fontSize: '20px', fontWeight: 900, color: '#000', margin: 0 }}>Editar membresía</h2>
            <p style={{ fontSize: '13px', color: '#999', margin: '4px 0 0' }}>{tenant.name}</p>
          </div>
          <button onClick={onClose} style={{ ...btn('#F0F0F0', '#666'), padding: '6px 12px' }}>✕</button>
        </div>

        {error && (
          <div style={{ background: '#FFE5E5', color: '#CC3333', borderRadius: '10px', padding: '10px 14px', fontSize: '13px', fontWeight: 600 }}>
            {error}
          </div>
        )}

        <Section title="Plan y estado">
          <Field label="Plan">
            <select style={inputStyle} value={plan} onChange={e => setPlan(e.target.value)}>
              {PLAN_OPTIONS.map(p => <option key={p} value={p}>{PLAN_LABEL[p] ?? p}</option>)}
            </select>
          </Field>
          <Field label="Estado">
            <select style={inputStyle} value={status} onChange={e => setStatus(e.target.value)}>
              {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s === 'active' ? 'Activo' : s === 'suspended' ? 'Suspendido' : 'Cancelado'}</option>)}
            </select>
          </Field>
          <Field label="Skin">
            <select style={inputStyle} value={skin} onChange={e => setSkin(e.target.value)}>
              {SKIN_OPTIONS.map(s => <option key={s} value={s}>{SKIN_LABEL[s] ?? s}</option>)}
            </select>
          </Field>
          <Field label="Cupo de números de WhatsApp">
            <input style={inputStyle} type="number" min="1" step="1" value={maxNumbers} onChange={e => setMaxNumbers(e.target.value)} />
          </Field>
        </Section>

        <Section title="Facturación">
          <Field label="Monto mensual">
            <input style={inputStyle} type="number" min="0" step="1" value={amount} onChange={e => setAmount(e.target.value)} />
          </Field>
          <Field label="Paga hasta">
            <input style={inputStyle} type="date" value={paidUntil} onChange={e => setPaidUntil(e.target.value)} />
          </Field>
        </Section>

        <Section title="Notas internas">
          <Field label="Notas (solo admin)">
            <textarea
              style={{ ...inputStyle, minHeight: '90px', resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }}
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Anotaciones sobre este cliente…"
            />
          </Field>
        </Section>

        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px' }}>
          <button onClick={onClose} style={btn('#F0F0F0', '#666')}>Cancelar</button>
          <button onClick={save} disabled={saving} style={btn('#C8FF00', '#000')}>
            {saving ? 'Guardando…' : 'Guardar membresía'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', borderTop: '1px solid #f0f0f0', paddingTop: '14px' }}>
      <h3 style={{ fontSize: '13px', fontWeight: 800, color: '#888', margin: 0, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{title}</h3>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <label style={{ fontSize: '11px', fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</label>
      {children}
    </div>
  );
}

const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000,
  display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '40px 16px', overflowY: 'auto',
};
const panel: React.CSSProperties = {
  background: '#fff', borderRadius: '20px', padding: '24px', width: '100%', maxWidth: '560px',
  display: 'flex', flexDirection: 'column', gap: '14px', boxShadow: '0 12px 48px rgba(0,0,0,0.25)',
};
