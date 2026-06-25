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

// Sección de Configuración para administrar los números de WhatsApp del tenant
// (tabla whatsapp_numbers). Visible para admin y agent: para otros roles no
// renderiza nada (la API igual exige rol admin o agent server-side).
export default function WhatsAppNumbersManager() {
  const { agent } = useAuth();
  const canManageNumbers = agent?.role === 'admin' || agent?.role === 'agent';

  const [numbers, setNumbers] = useState<WaNumber[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [saving,   setSaving]   = useState(false);
  const [error,    setError]    = useState('');

  // Alta
  const [label,         setLabel]         = useState('');
  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [accessToken,   setAccessToken]   = useState('');
  const [wabaId,        setWabaId]        = useState('');

  // Edición inline (label / token / waba)
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [editToken, setEditToken] = useState('');
  const [editWaba,  setEditWaba]  = useState('');
  const [clearToken, setClearToken] = useState(false);

  // Verificación contra Meta
  const [verifying, setVerifying] = useState<string | null>(null);
  const [verifyResult, setVerifyResult] = useState<Record<string, { ok: boolean; text: string }>>({});
  // Número real (display_phone_number) por línea, resuelto al verificar.
  const [phoneMap, setPhoneMap] = useState<Record<string, string>>({});

  // Eliminación: id de la línea con confirmación inline abierta.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

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

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!label.trim())          { setError('Completá el label.'); return; }
    if (!phoneNumberId.trim())  { setError('Completá el phone_number_id.'); return; }
    if (numbers.some((n) => n.phone_number_id === phoneNumberId.trim())) {
      setError('Ese phone_number_id ya está registrado.');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/whatsapp-numbers', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: label.trim(),
          phone_number_id: phoneNumberId.trim(),
          access_token: accessToken.trim(),
          waba_id: wabaId.trim(),
        }),
      });
      if (!res.ok) setError(await res.text());
      else {
        setLabel(''); setPhoneNumberId(''); setAccessToken(''); setWabaId('');
        setShowForm(false);
        await fetchNumbers();
      }
    } catch {
      setError('Error de red.');
    }
    setSaving(false);
  }

  function startEdit(n: WaNumber) {
    setEditingId(n.id);
    setEditLabel(n.label ?? '');
    setEditToken('');
    setEditWaba(n.waba_id ?? '');
    setClearToken(false);
    setError('');
  }

  async function handleSaveEdit(n: WaNumber) {
    const payload: Record<string, unknown> = { label: editLabel, waba_id: editWaba };
    // Token: solo se manda si se escribió uno nuevo o se pidió volver al global
    // (mandar siempre vaciaría el token propio sin querer).
    if (clearToken) payload.access_token = '';
    else if (editToken.trim()) payload.access_token = editToken.trim();
    setSaving(true);
    const ok = await patchNumber(n.id, payload);
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

  async function handleDelete(n: WaNumber) {
    setError('');
    try {
      const res = await fetch('/api/whatsapp-numbers', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: n.id }),
      });
      if (!res.ok) { setError(await res.text()); return; }
      await fetchNumbers();
      setConfirmDeleteId(null);
    } catch {
      setError('Error de red.');
    }
  }

  const activos = numbers.filter((n) => n.active).length;

  return (
    <SectionCard
      title="Números de WhatsApp"
      description="Líneas conectadas al panel. Cada conversación responde por el último número por el que escribió el cliente; el default se usa para contactos sin número asignado."
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>

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
                    Token: {n.has_token ? 'propio' : 'global (env)'}
                    {n.waba_id && <> · WABA: {n.waba_id}</>}
                    {' · '}Alta: {new Date(n.created_at).toLocaleDateString('es-AR')}
                  </p>
                </div>

                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                  <button onClick={() => handleVerify(n)} disabled={verifying === n.id} style={smallBtn}>
                    {verifying === n.id ? 'Verificando...' : 'Verificar'}
                  </button>
                  <button onClick={() => (isEditing ? setEditingId(null) : startEdit(n))} style={smallBtn}>
                    {isEditing ? 'Cancelar' : 'Editar'}
                  </button>
                  {!n.is_default && n.active && (
                    <button
                      onClick={() => patchNumber(n.id, { make_default: true })}
                      style={{ ...smallBtn, background: '#1a1a1a', color: '#C8FF00' }}
                    >
                      Hacer default
                    </button>
                  )}
                  {/* El default no se desactiva y el único activo tampoco (la API
                      también lo rechaza; acá directamente no se ofrece). */}
                  {!(n.active && (n.is_default || activos <= 1)) && (
                    <button
                      onClick={() => patchNumber(n.id, { active: !n.active })}
                      style={{
                        ...smallBtn,
                        background: n.active ? '#fff' : '#C8FF00',
                        color: n.active ? '#E53935' : '#000',
                        border: n.active ? '1px solid #f08080' : 'none',
                      }}
                    >
                      {n.active ? 'Desactivar' : 'Activar'}
                    </button>
                  )}
                  {!n.is_default && (
                    <button
                      onClick={() => setConfirmDeleteId(n.id)}
                      title="Eliminar línea"
                      style={{ ...smallBtn, color: '#E53935' }}
                    >
                      🗑
                    </button>
                  )}
                </div>
              </div>

              {confirmDeleteId === n.id && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', background: '#fff0f0', border: '1px solid #f0b0b0', borderRadius: '10px', padding: '10px 12px' }}>
                  <span style={{ fontSize: '13px', fontWeight: 600, color: '#a02020' }}>
                    ¿Eliminar esta línea? Esta acción no se puede deshacer.
                  </span>
                  <button
                    onClick={() => handleDelete(n)}
                    style={{ ...smallBtn, background: '#E53935', color: '#fff' }}
                  >
                    Sí, eliminar
                  </button>
                  <button onClick={() => setConfirmDeleteId(null)} style={smallBtn}>
                    Cancelar
                  </button>
                </div>
              )}

              {vr && (
                <p style={{ fontSize: '12px', fontWeight: 600, margin: 0, color: vr.ok ? '#1a7a3a' : '#E53935' }}>
                  {vr.text}
                </p>
              )}

              {isEditing && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', borderTop: '1px solid #eee', paddingTop: '12px' }}>
                  <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', flex: 1, minWidth: '160px' }}>
                      <label style={labelStyle}>Label</label>
                      <input value={editLabel} onChange={(e) => setEditLabel(e.target.value)} style={inputStyle} />
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', flex: 1, minWidth: '160px' }}>
                      <label style={labelStyle}>WABA ID</label>
                      <input value={editWaba} onChange={(e) => setEditWaba(e.target.value)} placeholder="(vacío = global)" style={inputStyle} />
                    </div>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <label style={labelStyle}>Access token</label>
                    <input
                      type="password"
                      value={editToken}
                      onChange={(e) => { setEditToken(e.target.value); setClearToken(false); }}
                      placeholder={n.has_token ? '•••••• (dejar vacío para no cambiarlo)' : '(vacío = usa el token global)'}
                      style={inputStyle}
                      disabled={clearToken}
                    />
                    {n.has_token && (
                      <label style={{ fontSize: '12px', color: '#888', display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
                        <input type="checkbox" checked={clearToken} onChange={(e) => setClearToken(e.target.checked)} />
                        Quitar el token propio y volver al global (env)
                      </label>
                    )}
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

        {!showForm ? (
          <button
            onClick={() => { setShowForm(true); setError(''); }}
            style={{ background: '#1a1a1a', color: '#C8FF00', fontWeight: 800, fontSize: '13px', border: 'none', borderRadius: '12px', padding: '10px 20px', cursor: 'pointer', alignSelf: 'flex-start' }}
          >
            + Agregar número
          </button>
        ) : (
          <form onSubmit={handleCreate} style={{ display: 'flex', flexDirection: 'column', gap: '12px', background: '#FAFAFA', borderRadius: '12px', padding: '16px' }}>
            <p style={{ fontSize: '14px', fontWeight: 800, color: '#000', margin: 0 }}>Nuevo número</p>
            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', flex: 1, minWidth: '160px' }}>
                <label style={labelStyle}>Label</label>
                <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder='Ej: Línea 2' style={inputStyle} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', flex: 1, minWidth: '160px' }}>
                <label style={labelStyle}>Phone number ID (Meta)</label>
                <input value={phoneNumberId} onChange={(e) => setPhoneNumberId(e.target.value)} placeholder="Ej: 113564937..." style={inputStyle} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', flex: 2, minWidth: '200px' }}>
                <label style={labelStyle}>Access token (opcional)</label>
                <input type="password" value={accessToken} onChange={(e) => setAccessToken(e.target.value)} placeholder="(vacío = usa el token global)" style={inputStyle} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', flex: 1, minWidth: '160px' }}>
                <label style={labelStyle}>WABA ID (opcional)</label>
                <input value={wabaId} onChange={(e) => setWabaId(e.target.value)} placeholder="(vacío = global)" style={inputStyle} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                type="submit"
                disabled={saving}
                style={{ background: saving ? '#e0e0e0' : '#C8FF00', color: '#000', fontWeight: 800, fontSize: '13px', border: 'none', borderRadius: '10px', padding: '10px 18px', cursor: saving ? 'not-allowed' : 'pointer' }}
              >
                {saving ? 'Guardando...' : 'Guardar número'}
              </button>
              <button
                type="button"
                onClick={() => { setShowForm(false); setError(''); }}
                style={{ ...smallBtn, padding: '10px 14px' }}
              >
                Cancelar
              </button>
            </div>
          </form>
        )}
      </div>
    </SectionCard>
  );
}
