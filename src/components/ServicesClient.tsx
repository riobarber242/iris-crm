'use client';

import React, { useEffect, useState } from 'react';

type Service = {
  id: string;
  name: string;
  icon: string | null;
  expires_at: string | null; // 'YYYY-MM-DD'
  notes: string | null;
  created_at: string;
};

type Status = {
  label: string;
  color: string;
  bg: string;
};

type Balance = { available: boolean; balance?: number };

// Info estática de planes gratuitos por servicio (badge ℹ️ + tooltip + link).
const FREE_PLAN_INFO: Record<string, { detail: string; url: string }> = {
  'Vercel': {
    detail: 'Plan gratuito — límite 100GB bandwidth/mes, 100hs build/mes',
    url: 'https://vercel.com/pricing',
  },
  'Supabase': {
    detail: 'Plan gratuito — límite 500MB DB, 2GB bandwidth, pausa tras 1 semana inactivo',
    url: 'https://supabase.com/pricing',
  },
};

// Estado derivado de expires_at vs hoy. Por vencer = menos de 30 días.
function statusFor(expires_at: string | null): Status {
  if (!expires_at) return { label: 'Sin definir', color: '#888', bg: '#F0F0F0' };

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const exp = new Date(`${expires_at}T00:00:00`);
  const days = Math.round((exp.getTime() - today.getTime()) / 86_400_000);

  if (days < 0)  return { label: 'Vencido',   color: '#CC3333', bg: '#FFE5E5' };
  if (days < 30) return { label: 'Por vencer', color: '#E07B00', bg: '#FFF1E0' };
  return { label: 'Activo', color: '#1a8a1a', bg: '#E6F7E6' };
}

function formatDate(d: string | null): string {
  if (!d) return 'Sin fecha';
  const [y, m, day] = d.split('-');
  return `${day}/${m}/${y}`;
}

// Alerta de saldo Anthropic para la card correspondiente.
type Alert = { color: string; bg: string; text: string; isAlert: boolean };
function anthropicAlert(b: Balance | null): Alert | null {
  if (!b) return null; // todavía cargando
  if (!b.available) {
    return { color: '#888', bg: '#F0F0F0', text: 'No se puede verificar saldo automáticamente', isAlert: false };
  }
  const v = b.balance ?? 0;
  const money = `$${v.toFixed(2)}`;
  if (v < 0.5) return { color: '#CC3333', bg: '#FFE5E5', text: `🔴 Créditos casi agotados: ${money}`, isAlert: true };
  if (v < 2)   return { color: '#E07B00', bg: '#FFF1E0', text: `⚠️ Saldo bajo: ${money} — Recargá créditos`, isAlert: true };
  return { color: '#1a8a1a', bg: '#E6F7E6', text: `Saldo: ${money}`, isAlert: false };
}

const btn = (bg: string, fg: string): React.CSSProperties => ({
  background: bg, color: fg, fontWeight: 700, fontSize: '12px', border: 'none',
  borderRadius: '8px', padding: '7px 14px', cursor: 'pointer',
});

const inputStyle: React.CSSProperties = {
  background: '#F5F5F5', border: '2px solid #eee', borderRadius: '10px',
  padding: '8px 10px', fontSize: '13px', color: '#1a1a1a', outline: 'none', width: '100%',
  boxSizing: 'border-box',
};

export default function ServicesClient() {
  const [services, setServices] = useState<Service[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState('');
  const [balance,  setBalance]  = useState<Balance | null>(null);

  const [editId, setEditId] = useState<string | null>(null);
  const [draft,  setDraft]  = useState<{ expires_at: string; notes: string }>({ expires_at: '', notes: '' });
  const [saving, setSaving] = useState(false);

  async function fetchServices() {
    try {
      const res = await fetch('/api/admin/services');
      if (res.ok) setServices(await res.json());
      else setError((await res.json().catch(() => ({}))).error ?? 'Error cargando servicios');
    } catch { setError('Error de red'); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    fetchServices();
    // Saldo Anthropic: se consulta al abrir el panel (client-side, sin cron).
    fetch('/api/admin/services/anthropic-balance')
      .then((r) => r.json())
      .then((d) => setBalance(d))
      .catch(() => setBalance({ available: false }));
  }, []);

  function startEdit(s: Service) {
    setError('');
    setEditId(s.id);
    setDraft({ expires_at: s.expires_at ?? '', notes: s.notes ?? '' });
  }

  async function saveEdit(id: string) {
    setSaving(true);
    setError('');
    try {
      const res = await fetch(`/api/admin/services/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expires_at: draft.expires_at || null, notes: draft.notes }),
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok) { setEditId(null); fetchServices(); }
      else setError(d.error ?? 'No se pudo guardar');
    } catch { setError('Error de red'); }
    finally { setSaving(false); }
  }

  if (loading) return <p style={{ textAlign: 'center', color: '#999', fontSize: '14px' }}>Cargando servicios…</p>;

  // Contador de alertas activas: vencimientos (vencido/por vencer) +
  // saldo Anthropic bajo/crítico + advertencias de plan gratuito.
  const expiryAlerts = services.filter((s) => {
    const l = statusFor(s.expires_at).label;
    return l === 'Vencido' || l === 'Por vencer';
  }).length;
  const balAlert = anthropicAlert(balance);
  const anthropicAlerts = balAlert?.isAlert ? 1 : 0;
  const freePlanAlerts = services.filter((s) => FREE_PLAN_INFO[s.name]).length;
  const totalAlerts = expiryAlerts + anthropicAlerts + freePlanAlerts;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {totalAlerts > 0 && (
        <div style={{
          background: '#FFF1E0', color: '#E07B00', borderRadius: '12px',
          padding: '10px 16px', fontSize: '14px', fontWeight: 800,
          display: 'inline-flex', alignItems: 'center', gap: '8px', alignSelf: 'flex-start',
        }}>
          ⚠️ {totalAlerts} {totalAlerts === 1 ? 'alerta activa' : 'alertas activas'}
        </div>
      )}

      {error && (
        <div style={{ background: '#FFE5E5', color: '#CC3333', borderRadius: '10px', padding: '10px 14px', fontSize: '13px', fontWeight: 600 }}>
          {error}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '16px' }}>
        {services.map((s) => {
          const st = statusFor(s.expires_at);
          const editing = editId === s.id;
          const freePlan = FREE_PLAN_INFO[s.name];
          const isAnthropic = s.name === 'Anthropic API';
          const alert = isAnthropic ? balAlert : null;
          return (
            <div key={s.id} style={{
              background: '#fff', borderRadius: '16px', padding: '18px',
              boxShadow: '0 1px 8px rgba(0,0,0,0.06)', display: 'flex', flexDirection: 'column', gap: '12px',
            }}>
              {/* Encabezado: ícono + nombre + estado */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span style={{ fontSize: '26px', lineHeight: 1 }}>{s.icon ?? '🔧'}</span>
                <span style={{ fontSize: '15px', fontWeight: 800, color: '#111', flex: 1 }}>{s.name}</span>
                <span style={{
                  background: st.bg, color: st.color, fontWeight: 800, fontSize: '11px',
                  borderRadius: '999px', padding: '4px 10px', whiteSpace: 'nowrap',
                  textTransform: 'uppercase', letterSpacing: '0.04em',
                }}>
                  {st.label}
                </span>
              </div>

              {/* Alerta de saldo Anthropic */}
              {alert && (
                <div style={{
                  background: alert.bg, color: alert.color, borderRadius: '10px',
                  padding: '8px 12px', fontSize: '12px', fontWeight: 700,
                }}>
                  {alert.text}
                </div>
              )}

              {/* Badge informativo de plan gratuito (hover → tooltip) */}
              {freePlan && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                  <span
                    title={freePlan.detail}
                    style={{
                      background: '#F0F0F0', color: '#666', borderRadius: '999px',
                      padding: '5px 10px', fontSize: '11px', fontWeight: 700, cursor: 'help',
                      display: 'inline-flex', alignItems: 'center', gap: '5px',
                    }}
                  >
                    ℹ️ Plan gratuito
                  </span>
                  <a
                    href={freePlan.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ fontSize: '11px', fontWeight: 700, color: '#4A90D9', textDecoration: 'none' }}
                  >
                    Ver planes ↗
                  </a>
                </div>
              )}

              {editing ? (
                <>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <label style={{ fontSize: '11px', fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Vencimiento</label>
                    <input type="date" style={inputStyle} value={draft.expires_at} onChange={e => setDraft({ ...draft, expires_at: e.target.value })} />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <label style={{ fontSize: '11px', fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Notas</label>
                    <textarea rows={3} style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }} value={draft.notes} onChange={e => setDraft({ ...draft, notes: e.target.value })} placeholder="Plan, costo, recordatorios…" />
                  </div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button onClick={() => saveEdit(s.id)} disabled={saving} style={{ ...btn('#C8FF00', '#000'), opacity: saving ? 0.6 : 1 }}>{saving ? 'Guardando…' : 'Guardar'}</button>
                    <button onClick={() => setEditId(null)} disabled={saving} style={btn('#F0F0F0', '#666')}>Cancelar</button>
                  </div>
                </>
              ) : (
                <>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
                    <span style={{ fontSize: '11px', fontWeight: 700, color: '#aaa', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Vence</span>
                    <span style={{ fontSize: '14px', fontWeight: 700, color: s.expires_at ? '#111' : '#ccc' }}>{formatDate(s.expires_at)}</span>
                  </div>
                  {s.notes && (
                    <p style={{ fontSize: '12px', color: '#666', margin: 0, whiteSpace: 'pre-wrap' }}>{s.notes}</p>
                  )}
                  <div>
                    <button onClick={() => startEdit(s)} style={btn('#F0F0F0', '#333')}>Editar</button>
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>

      {services.length === 0 && (
        <p style={{ textAlign: 'center', color: '#bbb', fontSize: '14px', padding: '20px 0' }}>
          No hay servicios todavía. Corré <code>supabase-services.sql</code> en Supabase.
        </p>
      )}
    </div>
  );
}
