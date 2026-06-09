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
  border: string;
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
// Texto siempre blanco; el color semántico va en el fondo del badge (sobre card celeste neón).
function statusFor(expires_at: string | null): Status {
  const border = 'rgba(255,255,255,0.3)';
  if (!expires_at) return { label: 'Sin definir', color: '#FFFFFF', bg: 'rgba(0,0,0,0.18)', border };

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const exp = new Date(`${expires_at}T00:00:00`);
  const days = Math.round((exp.getTime() - today.getTime()) / 86_400_000);

  if (days < 0)  return { label: 'Vencido',    color: '#FFFFFF', bg: 'rgba(220,38,38,0.92)', border };
  if (days < 30) return { label: 'Por vencer', color: '#FFFFFF', bg: '#F97316',              border };
  return { label: 'Activo', color: '#FFFFFF', bg: 'rgba(22,163,74,0.92)', border };
}

function formatDate(d: string | null): string {
  if (!d) return 'Sin fecha';
  const [y, m, day] = d.split('-');
  return `${day}/${m}/${y}`;
}

// Alerta de saldo Anthropic para la card correspondiente (texto blanco, fondo semántico).
type Alert = { bg: string; text: string; isAlert: boolean };
function anthropicAlert(b: Balance | null): Alert | null {
  if (!b) return null; // todavía cargando
  if (!b.available) {
    return { bg: 'rgba(0,0,0,0.18)', text: 'No se puede verificar saldo automáticamente', isAlert: false };
  }
  const v = b.balance ?? 0;
  const money = `$${v.toFixed(2)}`;
  if (v < 0.5) return { bg: 'rgba(220,38,38,0.92)', text: `🔴 Créditos casi agotados: ${money}`, isAlert: true };
  if (v < 2)   return { bg: '#F97316',              text: `⚠️ Saldo bajo: ${money} — Recargá créditos`, isAlert: true };
  return { bg: 'rgba(22,163,74,0.92)', text: `Saldo: ${money}`, isAlert: false };
}

const inputStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.4)', borderRadius: '10px',
  padding: '8px 10px', fontSize: '13px', color: '#FFFFFF', outline: 'none', width: '100%',
  boxSizing: 'border-box',
};

const fieldLabel: React.CSSProperties = {
  fontSize: '11px', fontWeight: 700, color: '#FFFFFF', opacity: 0.7,
  textTransform: 'uppercase', letterSpacing: '0.05em',
};

// Botón con hover (los estilos inline no soportan :hover).
function HoverButton({
  children, onClick, disabled, base, hover,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  base: React.CSSProperties;
  hover: React.CSSProperties;
}) {
  const [h, setH] = useState(false);
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
      style={{ ...base, ...(h && !disabled ? hover : null) }}
    >
      {children}
    </button>
  );
}

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

  if (loading) return <p style={{ textAlign: 'center', color: '#1A1A2E', opacity: 0.6, fontSize: '14px' }}>Cargando servicios…</p>;

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
          background: '#F97316', color: '#FFFFFF',
          borderRadius: '12px', padding: '10px 16px', fontSize: '14px', fontWeight: 800,
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
          const initial = (s.name.trim()[0] ?? '?').toUpperCase();
          return (
            <div key={s.id} style={{
              background: '#00CFFF',
              border: '1px solid rgba(255,255,255,0.2)',
              borderRadius: '16px',
              padding: '20px',
              boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
              display: 'flex', flexDirection: 'column', gap: '14px',
            }}>
              {/* Encabezado: círculo con inicial + nombre + estado */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <span style={{
                  width: '48px', height: '48px', borderRadius: '50%', background: '#000000',
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  color: '#FFFFFF', fontSize: '20px', fontWeight: 900, flexShrink: 0,
                }}>
                  {initial}
                </span>
                <span style={{ fontSize: '15px', fontWeight: 800, color: '#FFFFFF', flex: 1, minWidth: 0 }}>{s.name}</span>
                <span style={{
                  background: st.bg, color: st.color, border: `1px solid ${st.border}`,
                  fontWeight: 800, fontSize: '11px', borderRadius: '999px', padding: '4px 10px',
                  whiteSpace: 'nowrap', textTransform: 'uppercase', letterSpacing: '0.04em',
                }}>
                  {st.label}
                </span>
              </div>

              {/* Alerta de saldo Anthropic */}
              {alert && (
                <div style={{
                  background: alert.bg, color: '#FFFFFF', borderRadius: '10px',
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
                      background: 'rgba(255,255,255,0.2)', color: '#FFFFFF', borderRadius: '999px',
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
                    style={{ fontSize: '11px', fontWeight: 700, color: '#FFFFFF', textDecoration: 'underline' }}
                  >
                    Ver planes ↗
                  </a>
                </div>
              )}

              {editing ? (
                <>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <label style={fieldLabel}>Vencimiento</label>
                    <input type="date" style={inputStyle} value={draft.expires_at} onChange={e => setDraft({ ...draft, expires_at: e.target.value })} />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <label style={fieldLabel}>Notas</label>
                    <textarea rows={3} style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }} value={draft.notes} onChange={e => setDraft({ ...draft, notes: e.target.value })} placeholder="Plan, costo, recordatorios…" />
                  </div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <HoverButton
                      onClick={() => saveEdit(s.id)}
                      disabled={saving}
                      base={{ background: '#FFE500', color: '#1A1A1A', fontWeight: 800, fontSize: '12px', border: 'none', borderRadius: '8px', padding: '7px 14px', cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.6 : 1 }}
                      hover={{ background: '#FFF04D' }}
                    >
                      {saving ? 'Guardando…' : 'Guardar'}
                    </HoverButton>
                    <HoverButton
                      onClick={() => setEditId(null)}
                      disabled={saving}
                      base={{ background: 'rgba(255,255,255,0.18)', color: '#FFFFFF', fontWeight: 700, fontSize: '12px', border: '1px solid rgba(255,255,255,0.4)', borderRadius: '8px', padding: '7px 14px', cursor: 'pointer' }}
                      hover={{ background: 'rgba(255,255,255,0.3)' }}
                    >
                      Cancelar
                    </HoverButton>
                  </div>
                </>
              ) : (
                <>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
                    <span style={fieldLabel}>Vence</span>
                    <span style={{ fontSize: '14px', fontWeight: 800, color: s.expires_at ? '#CBFF00' : 'rgba(255,255,255,0.7)' }}>{formatDate(s.expires_at)}</span>
                  </div>
                  {s.notes && (
                    <p style={{ fontSize: '12px', color: '#FFFFFF', opacity: 0.85, margin: 0, whiteSpace: 'pre-wrap' }}>{s.notes}</p>
                  )}
                  <div>
                    <HoverButton
                      onClick={() => startEdit(s)}
                      base={{ background: '#000000', color: '#FFFFFF', fontWeight: 700, fontSize: '12px', border: 'none', borderRadius: '8px', padding: '7px 16px', cursor: 'pointer', transition: 'background 0.15s' }}
                      hover={{ background: '#1A1A1A' }}
                    >
                      Editar
                    </HoverButton>
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>

      {services.length === 0 && (
        <p style={{ textAlign: 'center', color: '#1A1A2E', opacity: 0.55, fontSize: '14px', padding: '20px 0' }}>
          No hay servicios todavía. Corré <code>supabase-services.sql</code> en Supabase.
        </p>
      )}
    </div>
  );
}
