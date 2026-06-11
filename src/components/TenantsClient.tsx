'use client';

import React, { useEffect, useState } from 'react';
import OnboardingWizard from './OnboardingWizard';

type Tenant = {
  id: string;
  name: string;
  whatsapp_phone_id: string | null;
  whatsapp_access_token: string | null;
  created_at: string;
};

const inputStyle: React.CSSProperties = {
  background: '#F5F5F5', border: '2px solid #eee', borderRadius: '10px',
  padding: '8px 10px', fontSize: '13px', color: '#1a1a1a', outline: 'none',
};
const btn = (bg: string, fg: string): React.CSSProperties => ({
  background: bg, color: fg, fontWeight: 700, fontSize: '12px', border: 'none',
  borderRadius: '8px', padding: '6px 12px', cursor: 'pointer',
});

// El access token es sensible: en la lista solo mostramos si está configurado.
function tokenStatus(t: string | null) {
  return t ? '✓ configurado' : '—';
}

export default function TenantsClient() {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');

  // inline edit
  const [editId, setEditId] = useState<string | null>(null);
  const [draft,  setDraft]  = useState<Partial<Tenant>>({});

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

  function startEdit(t: Tenant) {
    setEditId(t.id);
    setDraft({
      name: t.name,
      whatsapp_phone_id: t.whatsapp_phone_id ?? '',
      whatsapp_access_token: t.whatsapp_access_token ?? '',
    });
  }

  async function saveEdit(id: string) {
    setError('');
    const res = await fetch(`/api/tenants/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft),
    });
    const d = await res.json().catch(() => ({}));
    if (res.ok) { setEditId(null); fetchTenants(); }
    else setError(d.error ?? 'No se pudo guardar');
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

      {wizardOpen && (
        <OnboardingWizard onClose={() => setWizardOpen(false)} onCreated={fetchTenants} />
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
          <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1.4fr 1.2fr 1.4fr', gap: '10px', padding: '8px 16px', fontSize: '11px', fontWeight: 700, color: '#aaa', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            <span>Nombre</span><span>WhatsApp Phone ID</span><span>Access Token</span><span>Acciones</span>
          </div>

          {tenants.map((t) => {
            const editing = editId === t.id;
            return (
              <div key={t.id} style={{ display: 'grid', gridTemplateColumns: '1.4fr 1.4fr 1.2fr 1.4fr', gap: '10px', alignItems: 'center', background: '#fff', borderRadius: '12px', padding: '12px 16px', boxShadow: '0 1px 6px rgba(0,0,0,0.05)' }}>
                {/* nombre */}
                {editing
                  ? <input style={inputStyle} value={draft.name ?? ''} onChange={e => setDraft({ ...draft, name: e.target.value })} />
                  : <span style={{ fontSize: '13px', fontWeight: 700, color: '#111' }}>{t.name}</span>}

                {/* phone id */}
                {editing
                  ? <input style={inputStyle} value={draft.whatsapp_phone_id ?? ''} onChange={e => setDraft({ ...draft, whatsapp_phone_id: e.target.value })} placeholder="phone id" />
                  : <span style={{ fontSize: '12px', color: t.whatsapp_phone_id ? '#555' : '#ccc', fontFamily: 'monospace' }}>{t.whatsapp_phone_id || '—'}</span>}

                {/* access token */}
                {editing
                  ? <input style={inputStyle} type="password" value={draft.whatsapp_access_token ?? ''} onChange={e => setDraft({ ...draft, whatsapp_access_token: e.target.value })} placeholder="dejar vacío = quitar" />
                  : <span style={{ fontSize: '12px', fontWeight: 700, color: t.whatsapp_access_token ? '#1a8a1a' : '#ccc' }}>{tokenStatus(t.whatsapp_access_token)}</span>}

                {/* acciones */}
                <span style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                  {editing ? (
                    <>
                      <button onClick={() => saveEdit(t.id)} style={btn('#C8FF00', '#000')}>Guardar</button>
                      <button onClick={() => setEditId(null)} style={btn('#F0F0F0', '#666')}>Cancelar</button>
                    </>
                  ) : (
                    <button onClick={() => startEdit(t)} style={btn('#F0F0F0', '#333')}>Editar</button>
                  )}
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
