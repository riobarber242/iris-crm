"use client";

import React, { useEffect, useState } from 'react';
import { useAuth } from '@/components/AuthProvider';
import { SectionCard } from '@/components/ui/SectionCard';

type WaNumber = {
  id: string;
  label: string | null;
  phone_number_id: string;
  waba_id: string | null;
  active: boolean;
  is_default: boolean;
  created_at: string;
  has_token: boolean;
  // Solo frontend: el número real resuelto al Verificar contra Meta (no viene del GET).
  display_phone_number?: string;
};

const inputStyle: React.CSSProperties = {
  background: '#F5F5F5', border: 'none', borderRadius: '10px',
  padding: '10px 14px', fontSize: '14px', color: '#000', outline: 'none', width: '100%',
  boxSizing: 'border-box',
};

const labelStyle: React.CSSProperties = {
  fontSize: '11px', fontWeight: 700, color: '#999',
  textTransform: 'uppercase', letterSpacing: '0.08em',
};

const badgeStyle: React.CSSProperties = {
  fontSize: '11px', fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase',
  padding: '3px 10px', borderRadius: '20px', whiteSpace: 'nowrap',
};

const smallBtn: React.CSSProperties = {
  background: '#F5F5F5', color: '#555', fontWeight: 700, fontSize: '12px',
  border: 'none', borderRadius: '8px', padding: '7px 12px', cursor: 'pointer', whiteSpace: 'nowrap',
};

// Sección de Configuración para VER los números de WhatsApp del tenant
// (tabla whatsapp_numbers). Solo lectura para todos los roles (admin y agent):
// ver las líneas, renombrar (label), hacer default y verificar contra Meta.
//
// El ALTA y la BAJA de líneas (y la carga de token/WABA/app_secret cifrados) se
// hacen ÚNICAMENTE desde el panel de Clientes (admin) → modal del cliente. Antes
// esta pantalla tenía un form de alta propio SIN app_secret, que dejaba dos vías
// de carga y causaba el 401 "Firma inválida"; se quitó para dejar una sola.
export default function WhatsAppNumbersManager() {
  const { agent } = useAuth();
  const canManageNumbers = agent?.role === 'admin' || agent?.role === 'agent';

  const [numbers, setNumbers] = useState<WaNumber[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving,  setSaving]  = useState(false);
  const [error,   setError]   = useState('');

  // Edición inline: solo el label (renombrar).
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState('');

  // Verificación contra Meta
  const [verifying, setVerifying] = useState<string | null>(null);
  const [verifyResult, setVerifyResult] = useState<Record<string, { ok: boolean; text: string }>>({});
  // Número real (display_phone_number) por línea, resuelto al verificar.
  const [phoneMap, setPhoneMap] = useState<Record<string, string>>({});

  async function fetchNumbers() {
    try {
      const res = await fetch('/api/whatsapp-numbers');
      if (res.ok) setNumbers(await res.json());
    } catch {}
    finally { setLoading(false); }
  }

  useEffect(() => {
    if (canManageNumbers) fetchNumbers();
  }, [canManageNumbers]);

  if (!canManageNumbers) return null;

  async function patchNumber(id: string, payload: Record<string, unknown>): Promise<boolean> {
    setError('');
    try {
      const res = await fetch('/api/whatsapp-numbers', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...payload }),
      });
      if (!res.ok) { setError(await res.text()); return false; }
      await fetchNumbers();
      return true;
    } catch {
      setError('Error de red.');
      return false;
    }
  }

  function startEdit(n: WaNumber) {
    setEditingId(n.id);
    setEditLabel(n.label ?? '');
    setError('');
  }

  async function handleSaveEdit(n: WaNumber) {
    setSaving(true);
    const ok = await patchNumber(n.id, { label: editLabel });
    setSaving(false);
    if (ok) setEditingId(null);
  }

  async function handleVerify(n: WaNumber) {
    setVerifying(n.id);
    setVerifyResult((prev) => ({ ...prev, [n.id]: undefined as any }));
    try {
      const res = await fetch('/api/whatsapp-numbers/verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: n.id }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.ok) {
        setVerifyResult((prev) => ({ ...prev, [n.id]: { ok: true, text: `✅ ${data.display_phone_number ?? 'OK'}` } }));
        if (data.display_phone_number) {
          setPhoneMap((prev) => ({ ...prev, [n.id]: data.display_phone_number }));
        }
      } else {
        setVerifyResult((prev) => ({ ...prev, [n.id]: { ok: false, text: `❌ ${data?.error ?? 'Error verificando'}` } }));
      }
    } catch {
      setVerifyResult((prev) => ({ ...prev, [n.id]: { ok: false, text: '❌ Error de red' } }));
    }
    setVerifying(null);
  }

  return (
    <SectionCard
      title="Números de WhatsApp"
      description="Líneas conectadas al panel. Cada conversación responde por el último número por el que escribió el cliente; el default se usa para contactos sin número asignado."
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>

        <p style={{ fontSize: '12px', color: '#888', background: '#FAFAFA', borderRadius: '10px', padding: '10px 14px', margin: 0, lineHeight: 1.5 }}>
          ℹ️ Acá podés renombrar una línea, elegir el número por defecto y verificarlo.
          El alta y la baja de líneas las gestiona el administrador desde el panel de Clientes.
        </p>

        {loading && <p style={{ color: '#999', fontSize: '13px', margin: 0 }}>Cargando números...</p>}

        {!loading && numbers.length === 0 && (
          <p style={{ color: '#999', fontSize: '13px', margin: 0 }}>No hay números registrados todavía.</p>
        )}

        {numbers.map((n) => {
          const vr = verifyResult[n.id];
          const isEditing = editingId === n.id;
          return (
            <div key={n.id} style={{ background: '#F8F8F8', borderRadius: '12px', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <p style={{ fontSize: '15px', fontWeight: 800, color: '#000', margin: 0 }}>{n.label ?? '(sin label)'}</p>
                    {n.is_default && (
                      <span style={{ ...badgeStyle, background: '#1a1a1a', color: '#C8FF00' }}>Default</span>
                    )}
                    <span style={{
                      ...badgeStyle,
                      background: n.active ? '#e8fff0' : '#F0F0F0',
                      color:      n.active ? '#1a7a3a' : '#888',
                      border:     n.active ? '1px solid #5ad87a' : '1px solid #e0e0e0',
                    }}>
                      {n.active ? 'Activo' : 'Inactivo'}
                    </span>
                  </div>
                  <p style={{ fontSize: '12px', color: '#888', margin: '4px 0 0 0', fontFamily: 'monospace' }}>
                    {n.phone_number_id}
                  </p>
                  {phoneMap[n.id] && (
                    <p style={{ fontSize: '13px', fontWeight: 700, color: '#111', margin: '2px 0 0 0' }}>
                      {phoneMap[n.id]}
                    </p>
                  )}
                  <p style={{ fontSize: '11px', color: '#aaa', margin: '3px 0 0 0' }}>
                    Alta: {new Date(n.created_at).toLocaleDateString('es-AR')}
                  </p>
                </div>

                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                  <button onClick={() => handleVerify(n)} disabled={verifying === n.id} style={smallBtn}>
                    {verifying === n.id ? 'Verificando...' : 'Verificar'}
                  </button>
                  <button onClick={() => (isEditing ? setEditingId(null) : startEdit(n))} style={smallBtn}>
                    {isEditing ? 'Cancelar' : 'Renombrar'}
                  </button>
                  {!n.is_default && n.active && (
                    <button
                      onClick={() => patchNumber(n.id, { make_default: true })}
                      style={{ ...smallBtn, background: '#1a1a1a', color: '#C8FF00' }}
                    >
                      Hacer default
                    </button>
                  )}
                </div>
              </div>

              {vr && (
                <p style={{ fontSize: '12px', fontWeight: 600, margin: 0, color: vr.ok ? '#1a7a3a' : '#E53935' }}>
                  {vr.text}
                </p>
              )}

              {isEditing && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', borderTop: '1px solid #eee', paddingTop: '12px' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxWidth: '320px' }}>
                    <label style={labelStyle}>Label</label>
                    <input value={editLabel} onChange={(e) => setEditLabel(e.target.value)} style={inputStyle} />
                  </div>
                  <button
                    onClick={() => handleSaveEdit(n)}
                    disabled={saving}
                    style={{ background: saving ? '#e0e0e0' : '#C8FF00', color: '#000', fontWeight: 800, fontSize: '13px', border: 'none', borderRadius: '10px', padding: '10px 18px', cursor: saving ? 'not-allowed' : 'pointer', alignSelf: 'flex-start' }}
                  >
                    {saving ? 'Guardando...' : 'Guardar cambios'}
                  </button>
                </div>
              )}
            </div>
          );
        })}

        {error && <p style={{ fontSize: '13px', color: '#E53935', fontWeight: 600, margin: 0 }}>{error}</p>}
      </div>
    </SectionCard>
  );
}
