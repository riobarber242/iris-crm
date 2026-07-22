'use client';

import React, { useState } from 'react';
import { irisSystemPrompt } from '@/lib/system-prompt';

// ─────────────────────────────────────────────────────────────────────────────
// Wizard de alta de un agente nuevo (admin-driven). 6 pasos guiados:
//   1. Datos del negocio   2. Usuario de acceso   3. Config del bot
//   4. Número de WhatsApp   5. Operadores          6. Resumen y confirmación
// Al confirmar, POST /api/admin/onboarding crea todo de forma atómica y se
// muestra la pantalla final con las credenciales listas para copiar.
// ─────────────────────────────────────────────────────────────────────────────

type OperatorDraft = { username: string; name: string; password: string };

type CreatedCredential = { id: string; username: string; password: string; role: 'agent' | 'operator'; name: string };
type OnboardingResult = {
  tenant: { id: string; name: string };
  agent: CreatedCredential;
  operators: CreatedCredential[];
  warnings: string[];
};

const STEPS = ['Negocio', 'Acceso', 'Bot', 'WhatsApp', 'Operadores', 'Resumen'];

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

export default function OnboardingWizard({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [step, setStep] = useState(0);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<OnboardingResult | null>(null);

  // ── Datos del formulario ──
  const [businessName, setBusinessName] = useState('');
  const [businessEmail, setBusinessEmail] = useState('');
  const [agentUsername, setAgentUsername] = useState('');
  const [agentPassword, setAgentPassword] = useState('');
  const [systemPrompt, setSystemPrompt] = useState(irisSystemPrompt);
  const [waPhoneId, setWaPhoneId] = useState('');
  const [waWabaId, setWaWabaId] = useState('');
  const [waDisplay, setWaDisplay] = useState('');
  const [operators, setOperators] = useState<OperatorDraft[]>([]);

  const emailValid = !businessEmail.trim() || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(businessEmail.trim());

  // Validación por paso: qué falta para poder avanzar.
  function stepError(s: number): string {
    if (s === 0) {
      if (!businessName.trim()) return 'Ingresá el nombre del negocio.';
      if (!emailValid) return 'El email de contacto no es válido.';
    }
    if (s === 1) {
      if (!agentUsername.trim()) return 'Ingresá el usuario del agente.';
      if (agentPassword.length < 6) return 'La contraseña debe tener al menos 6 caracteres.';
    }
    if (s === 2) {
      if (!systemPrompt.trim()) return 'El system prompt no puede quedar vacío.';
    }
    if (s === 4) {
      for (const [i, op] of operators.entries()) {
        const filled = op.username.trim() || op.password || op.name.trim();
        if (!filled) continue;
        if (!op.username.trim()) return `El operador #${i + 1} necesita un usuario.`;
        if (op.password.length < 6) return `La contraseña del operador #${i + 1} debe tener al menos 6 caracteres.`;
      }
    }
    return '';
  }

  function next() {
    const e = stepError(step);
    if (e) { setError(e); return; }
    setError('');
    setStep(s => Math.min(s + 1, STEPS.length - 1));
  }
  function back() { setError(''); setStep(s => Math.max(s - 1, 0)); }

  function addOperator() { setOperators(o => [...o, { username: '', name: '', password: '' }]); }
  function removeOperator(i: number) { setOperators(o => o.filter((_, idx) => idx !== i)); }
  function updateOperator(i: number, patch: Partial<OperatorDraft>) {
    setOperators(o => o.map((op, idx) => idx === i ? { ...op, ...patch } : op));
  }

  // Operadores efectivamente cargados (filas con al menos usuario).
  const filledOperators = operators.filter(o => o.username.trim());

  async function submit() {
    setError('');
    setSubmitting(true);
    try {
      const payload = {
        business:  { name: businessName.trim(), email: businessEmail.trim() || null },
        agent:     { username: agentUsername.trim(), password: agentPassword },
        systemPrompt,
        whatsapp:  { phoneId: waPhoneId.trim() || null, wabaId: waWabaId.trim() || null, displayNumber: waDisplay.trim() || null },
        operators: filledOperators.map(o => ({ username: o.username.trim(), name: o.name.trim() || undefined, password: o.password })),
      };
      const res = await fetch('/api/admin/onboarding', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok) {
        setResult(d as OnboardingResult);
        onCreated();
      } else {
        setError(d.error ?? 'No se pudo crear el agente');
      }
    } catch {
      setError('Error de red');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={overlay} onClick={result ? undefined : onClose}>
      <div style={panel} onClick={e => e.stopPropagation()}>
        {result ? (
          <DoneScreen result={result} onClose={onClose} />
        ) : (
          <>
            {/* Header + stepper */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '4px' }}>
              <h2 style={{ fontSize: '20px', fontWeight: 900, color: '#000', margin: 0 }}>Nuevo agente</h2>
              <button onClick={onClose} style={{ ...btn('#F0F0F0', '#666'), padding: '6px 12px' }}>✕</button>
            </div>
            <Stepper step={step} />

            {error && (
              <div style={{ background: '#FFE5E5', color: '#CC3333', borderRadius: '10px', padding: '10px 14px', fontSize: '13px', fontWeight: 600 }}>
                {error}
              </div>
            )}

            <div style={{ minHeight: '260px' }}>
              {step === 0 && (
                <Section title="Datos del negocio" subtitle="Crea el tenant. El email queda como contacto del agente.">
                  <Field label="Nombre del negocio / agente *">
                    <input style={inputStyle} value={businessName} onChange={e => setBusinessName(e.target.value)} placeholder="Casino XYZ" autoFocus />
                  </Field>
                  <Field label="Email de contacto">
                    <input style={inputStyle} type="email" value={businessEmail} onChange={e => setBusinessEmail(e.target.value)} placeholder="contacto@casino.com" />
                  </Field>
                </Section>
              )}

              {step === 1 && (
                <Section title="Usuario de acceso" subtitle="Crea el login del agente (rol agente) atado al tenant nuevo.">
                  <Field label="Usuario *">
                    <input style={inputStyle} value={agentUsername} onChange={e => setAgentUsername(e.target.value)} placeholder="casinoxyz" autoFocus />
                  </Field>
                  <Field label="Contraseña * (mín. 6)">
                    <PasswordInput value={agentPassword} onChange={setAgentPassword} />
                  </Field>
                </Section>
              )}

              {step === 2 && (
                <Section title="Configuración del bot" subtitle="Instrucciones del bot para este tenant (system prompt). Editable.">
                  <textarea
                    style={{ ...inputStyle, minHeight: '220px', resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }}
                    value={systemPrompt}
                    onChange={e => setSystemPrompt(e.target.value)}
                  />
                </Section>
              )}

              {step === 3 && (
                <Section title="Número de WhatsApp (opcional)" subtitle="Si lo dejás vacío, se carga después. El alta no falla por esto.">
                  <Field label="Phone Number ID">
                    <input style={inputStyle} value={waPhoneId} onChange={e => setWaPhoneId(e.target.value)} placeholder="1135649372965076" />
                  </Field>
                  <Field label="WABA ID">
                    <input style={inputStyle} value={waWabaId} onChange={e => setWaWabaId(e.target.value)} placeholder="WhatsApp Business Account ID" />
                  </Field>
                  <Field label="Número visible">
                    <input style={inputStyle} value={waDisplay} onChange={e => setWaDisplay(e.target.value)} placeholder="+54 9 11 1234-5678" />
                  </Field>
                </Section>
              )}

              {step === 4 && (
                <Section title="Operadores (opcional)" subtitle="Agregá 0 o varios operadores (rol operador) atados al tenant.">
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    {operators.map((op, i) => (
                      <div key={i} style={{ background: '#F9F9F9', borderRadius: '12px', padding: '14px', display: 'flex', flexDirection: 'column', gap: '10px', position: 'relative' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ fontSize: '12px', fontWeight: 800, color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Operador #{i + 1}</span>
                          <button onClick={() => removeOperator(i)} style={{ ...btn('#FFE5E5', '#CC3333'), padding: '4px 10px', fontSize: '12px' }}>Quitar</button>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                          <Field label="Usuario *"><input style={inputStyle} value={op.username} onChange={e => updateOperator(i, { username: e.target.value })} placeholder="operador1" /></Field>
                          <Field label="Nombre"><input style={inputStyle} value={op.name} onChange={e => updateOperator(i, { name: e.target.value })} placeholder="Matías" /></Field>
                        </div>
                        <Field label="Contraseña * (mín. 6)"><PasswordInput value={op.password} onChange={v => updateOperator(i, { password: v })} /></Field>
                      </div>
                    ))}
                    <button onClick={addOperator} style={{ ...btn('#EEE', '#333'), alignSelf: 'flex-start' }}>+ Agregar operador</button>
                  </div>
                </Section>
              )}

              {step === 5 && (
                <Section title="Resumen y confirmación" subtitle="Revisá todo antes de crear. Las contraseñas se muestran al confirmar.">
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '14px' }}>
                    <SummaryRow label="Negocio" value={businessName} />
                    <SummaryRow label="Email" value={businessEmail || '—'} />
                    <SummaryRow label="Usuario agente" value={agentUsername} />
                    <SummaryRow label="WhatsApp Phone ID" value={waPhoneId || '—'} />
                    <SummaryRow label="WABA ID" value={waWabaId || '—'} />
                    <SummaryRow label="Número visible" value={waDisplay || '—'} />
                    <SummaryRow label="Operadores" value={filledOperators.length ? filledOperators.map(o => o.username).join(', ') : 'ninguno'} />
                    <SummaryRow label="System prompt" value={`${systemPrompt.trim().slice(0, 80)}${systemPrompt.trim().length > 80 ? '…' : ''}`} />
                  </div>
                </Section>
              )}
            </div>

            {/* Navegación */}
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '8px' }}>
              <button onClick={step === 0 ? onClose : back} style={btn('#F0F0F0', '#666')}>
                {step === 0 ? 'Cancelar' : '← Atrás'}
              </button>
              {step < STEPS.length - 1 ? (
                <button onClick={next} style={btn('#C8FF00', '#000')}>Siguiente →</button>
              ) : (
                <button onClick={submit} disabled={submitting} style={btn('#C8FF00', '#000')}>
                  {submitting ? 'Creando…' : 'Crear agente'}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Stepper({ step }: { step: number }) {
  return (
    <div style={{ display: 'flex', gap: '6px', margin: '4px 0 12px' }}>
      {STEPS.map((label, i) => (
        <div key={label} style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <div style={{ height: '4px', borderRadius: '2px', background: i <= step ? '#C8FF00' : '#eee' }} />
          <span style={{ fontSize: '10px', fontWeight: 700, color: i === step ? '#000' : '#bbb', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</span>
        </div>
      ))}
    </div>
  );
}

function Section({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      <div>
        <h3 style={{ fontSize: '16px', fontWeight: 800, color: '#000', margin: 0 }}>{title}</h3>
        <p style={{ fontSize: '12px', color: '#999', margin: '4px 0 0' }}>{subtitle}</p>
      </div>
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

function PasswordInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [show, setShow] = useState(false);
  return (
    <div style={{ display: 'flex', gap: '8px' }}>
      <input style={inputStyle} type={show ? 'text' : 'password'} value={value} onChange={e => onChange(e.target.value)} placeholder="••••••" />
      <button type="button" onClick={() => setShow(s => !s)} style={{ ...btn('#EEE', '#333'), padding: '10px 12px', whiteSpace: 'nowrap' }}>{show ? 'Ocultar' : 'Ver'}</button>
      <button type="button" onClick={() => { onChange(generatePassword()); }} style={{ ...btn('#1a1a1a', '#C8FF00'), padding: '10px 12px', whiteSpace: 'nowrap' }}>Generar</button>
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', gap: '10px', borderBottom: '1px solid #f0f0f0', paddingBottom: '8px' }}>
      <span style={{ fontSize: '12px', fontWeight: 700, color: '#999', minWidth: '150px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</span>
      <span style={{ fontSize: '14px', color: '#222', wordBreak: 'break-word' }}>{value}</span>
    </div>
  );
}

function DoneScreen({ result, onClose }: { result: OnboardingResult; onClose: () => void }) {
  const allCreds = [result.agent, ...result.operators];
  const copyAll = () => {
    const text = [
      `Agente: ${result.tenant.name}`,
      ...allCreds.map(c => `${c.role === 'agent' ? 'Agente' : 'Operador'} — usuario: ${c.username} · contraseña: ${c.password}`),
    ].join('\n');
    navigator.clipboard?.writeText(text);
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div>
        <h2 style={{ fontSize: '20px', fontWeight: 900, color: '#000', margin: 0 }}>✓ Agente creado</h2>
        <p style={{ fontSize: '13px', color: '#999', margin: '4px 0 0' }}>
          Guardá estas credenciales: las contraseñas no se vuelven a mostrar.
        </p>
      </div>

      {result.warnings.length > 0 && result.warnings.map((w, i) => (
        <div key={i} style={{ background: '#FFF6E0', color: '#9a6b00', borderRadius: '10px', padding: '10px 14px', fontSize: '13px', fontWeight: 600 }}>{w}</div>
      ))}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {allCreds.map(c => <CredCard key={c.id} cred={c} />)}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px' }}>
        <button onClick={copyAll} style={btn('#EEE', '#333')}>Copiar todo</button>
        <button onClick={onClose} style={btn('#C8FF00', '#000')}>Listo</button>
      </div>
    </div>
  );
}

function CredCard({ cred }: { cred: CreatedCredential }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(`usuario: ${cred.username} · contraseña: ${cred.password}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div style={{ background: '#F9F9F9', borderRadius: '12px', padding: '14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 }}>
        <span style={{ fontSize: '10px', fontWeight: 800, color: cred.role === 'agent' ? '#7da000' : '#888', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {cred.role === 'agent' ? 'Agente' : 'Operador'} · {cred.name}
        </span>
        <span style={{ fontSize: '14px', color: '#222', fontFamily: 'monospace', wordBreak: 'break-all' }}>
          {cred.username} / {cred.password}
        </span>
      </div>
      <button onClick={copy} style={{ ...btn(copied ? '#C8FF00' : '#1a1a1a', copied ? '#000' : '#C8FF00'), padding: '8px 14px', whiteSpace: 'nowrap' }}>
        {copied ? '✓ Copiado' : 'Copiar'}
      </button>
    </div>
  );
}

const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000,
  display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '40px 16px', overflowY: 'auto',
};
const panel: React.CSSProperties = {
  background: '#fff', borderRadius: '20px', padding: '24px', width: '100%', maxWidth: '620px',
  display: 'flex', flexDirection: 'column', gap: '14px', boxShadow: '0 12px 48px rgba(0,0,0,0.25)',
};
