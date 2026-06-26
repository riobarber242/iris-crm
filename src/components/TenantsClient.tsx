'use client';

import React, { useEffect, useState } from 'react';
import OnboardingWizard from './OnboardingWizard';

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

function fmtAmount(n: number): string {
  return '$' + (Number(n) || 0).toLocaleString('es-AR');
}
function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('es-AR');
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
  // id del tenant cuyo status se está togglear (suspender/activar)
  const [togglingId, setTogglingId] = useState<string | null>(null);

  // wizard de alta guiada
  const [wizardOpen, setWizardOpen] = useState(false);

  async function fetchTenants() {
    try {
      const res = await fetch('/api/tenants');
      if (res.ok) setTenants(await res.json());
      else setError((await res.json().catch(() => ({}))).error ?? 'Error cargando tenants');
    } catch { setError('Error de red'); }
    finally { setLoading(false); }
  }

  useEffect(() => { fetchTenants(); }, []);

  // Suspender / Activar: toggle directo de status sin abrir el modal.
  async function toggleStatus(t: Tenant) {
    const next = t.status === 'suspended' ? 'active' : 'suspended';
    setTogglingId(t.id);
    setError('');
    try {
      const res = await fetch(`/api/tenants/${t.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: next }),
      });
      if (res.ok) await fetchTenants();
      else setError((await res.json().catch(() => ({}))).error ?? 'No se pudo cambiar el estado');
    } catch { setError('Error de red'); }
    finally { setTogglingId(null); }
  }

  // Nombre · Skin · Plan · Estado · Paga hasta · Monto · Acciones
  const cols = '1.6fr 1fr 0.9fr 1fr 1fr 1fr 1.4fr';

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
          + Nuevo agente
        </button>
      </div>

      {error && (
        <div style={{ background: '#FFE5E5', color: '#CC3333', borderRadius: '10px', padding: '10px 14px', fontSize: '13px', fontWeight: 600 }}>
          {error}
        </div>
      )}

      {/* Tabla */}
      {loading ? (
        <p style={{ textAlign: 'center', color: '#999', fontSize: '14px' }}>Cargando tenants…</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: cols, gap: '10px', padding: '8px 16px', fontSize: '11px', fontWeight: 700, color: '#aaa', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            <span>Nombre</span><span>Skin</span><span>Plan</span><span>Estado</span><span>Paga hasta</span><span>Monto</span><span>Acciones</span>
          </div>

          {tenants.map((t) => {
            const badge = statusBadge(t);
            return (
              <div key={t.id} style={{ display: 'grid', gridTemplateColumns: cols, gap: '10px', alignItems: 'center', background: '#fff', borderRadius: '12px', padding: '12px 16px', boxShadow: '0 1px 6px rgba(0,0,0,0.05)' }}>
                {/* Nombre + usuario como subtítulo */}
                <span style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
                  <span style={{ fontSize: '13px', fontWeight: 700, color: '#111', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</span>
                  <span style={{ fontSize: '11px', color: t.username ? '#999' : '#ccc', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t.username || '—'}
                  </span>
                </span>

                <span style={{ fontSize: '13px', color: '#555' }}>{SKIN_LABEL[t.skin] ?? t.skin ?? '—'}</span>

                <span style={{ fontSize: '13px', fontWeight: 600, color: '#555' }}>{PLAN_LABEL[t.plan] ?? t.plan ?? '—'}</span>

                <span>
                  <span style={{
                    display: 'inline-block', fontSize: '11px', fontWeight: 800, borderRadius: '999px',
                    padding: '3px 10px', letterSpacing: '0.03em', background: badge.bg, color: badge.fg,
                  }}>
                    {badge.label}
                  </span>
                </span>

                <span style={{ fontSize: '13px', color: '#555' }}>{fmtDate(t.paid_until)}</span>

                <span style={{ fontSize: '13px', fontWeight: 700, color: '#111' }}>{fmtAmount(t.monthly_amount)}</span>

                <span style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                  <button onClick={() => setEditingMembership(t)} style={{ ...btn('#1a1a1a', '#C8FF00'), padding: '6px 12px', fontSize: '12px' }}>Membresía</button>
                  <button
                    onClick={() => toggleStatus(t)}
                    disabled={togglingId === t.id}
                    style={{ ...btn(t.status === 'suspended' ? '#E7F9D5' : '#FFE0E0', t.status === 'suspended' ? '#3F7A12' : '#C0392B'), padding: '6px 12px', fontSize: '12px', opacity: togglingId === t.id ? 0.6 : 1 }}
                  >
                    {togglingId === t.id ? '…' : (t.status === 'suspended' ? 'Activar' : 'Suspender')}
                  </button>
                  <button onClick={() => setEditing(t)} style={{ ...btn('#F0F0F0', '#333'), padding: '6px 12px', fontSize: '12px' }}>Agente</button>
                </span>
              </div>
            );
          })}

          {tenants.length === 0 && (
            <p style={{ textAlign: 'center', color: '#bbb', fontSize: '14px', padding: '20px 0' }}>No hay tenants todavía.</p>
          )}
        </div>
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
  const [phoneId,  setPhoneId]  = useState(tenant.whatsapp_phone_id ?? '');
  const [wabaId,   setWabaId]   = useState(tenant.whatsapp_waba_id ?? '');
  const [display,  setDisplay]  = useState(tenant.whatsapp_display_number ?? '');
  const [token,    setToken]    = useState(tenant.whatsapp_access_token ?? '');
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
        whatsapp_phone_id: phoneId.trim(),
        whatsapp_access_token: token.trim(),
        waba_id: wabaId.trim(),
        numero_visible: display.trim(),
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
            <h2 style={{ fontSize: '20px', fontWeight: 900, color: '#000', margin: 0 }}>Editar agente</h2>
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

        {/* Sección 2 — WhatsApp */}
        <Section title="WhatsApp">
          <Field label="Phone Number ID">
            <input style={inputStyle} value={phoneId} onChange={e => setPhoneId(e.target.value)} placeholder="dejar vacío = sin línea" />
          </Field>
          <Field label="WABA ID">
            <input style={inputStyle} value={wabaId} onChange={e => setWabaId(e.target.value)} placeholder="opcional" />
          </Field>
          <Field label="Número visible">
            <input style={inputStyle} value={display} onChange={e => setDisplay(e.target.value)} placeholder="+54 9 11 1234-5678 (opcional)" />
          </Field>
          <Field label="Access Token">
            <input style={inputStyle} value={token} onChange={e => setToken(e.target.value)} placeholder="dejar vacío = usa token global" />
          </Field>
        </Section>

        {/* Sección 3 — Bot */}
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

  const [error, setError]   = useState('');
  const [saving, setSaving] = useState(false);

  async function save() {
    const amountNum = Math.trunc(Number(amount));
    if (!Number.isFinite(amountNum) || amountNum < 0) { setError('El monto mensual debe ser un entero ≥ 0.'); return; }

    setError('');
    setSaving(true);
    try {
      const body = {
        plan, status, skin,
        monthly_amount: amountNum,
        paid_until: paidUntil || '',   // vacío → el backend lo guarda como null
        notes,
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
