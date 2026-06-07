'use client';

import React, { useEffect, useState } from 'react';

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

  // create form
  const [nu, setNu] = useState({ name: '', whatsapp_phone_id: '', whatsapp_access_token: '' });
  const [creating, setCreating] = useState(false);

  // inline edit
  const [editId, setEditId] = useState<string | null>(null);
  const [draft,  setDraft]  = useState<Partial<Tenant>>({});

  async function fetchTenants() {
    try {
      const res = await fetch('/api/tenants');
      if (res.ok) setTenants(await res.json());
      else setError((await res.json().catch(() => ({}))).error ?? 'Error cargando tenants');
    } catch { setError('Error de red'); }
    finally { setLoading(false); }
  }

  useEffect(() => { fetchTenants(); }, []);

  async function createTenant(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setCreating(true);
    try {
      const res = await fetch('/api/tenants', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(nu),
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok) {
        setNu({ name: '', whatsapp_phone_id: '', whatsapp_access_token: '' });
        fetchTenants();
      } else {
        setError(d.error ?? 'No se pudo crear');
      }
    } catch { setError('Error de red'); }
    finally { setCreating(false); }
  }

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

      {error && (
        <div style={{ background: '#FFE5E5', color: '#CC3333', borderRadius: '10px', padding: '10px 14px', fontSize: '13px', fontWeight: 600 }}>
          {error}
        </div>
      )}

      {/* Crear tenant */}
      <form onSubmit={createTenant} style={{ background: '#fff', borderRadius: '16px', padding: '18px', boxShadow: '0 1px 8px rgba(0,0,0,0.06)', display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'flex-end' }}>
        <Field label="Nombre"><input style={inputStyle} value={nu.name} onChange={e => setNu({ ...nu, name: e.target.value })} placeholder="Casino XYZ" /></Field>
        <Field label="WhatsApp Phone ID"><input style={{ ...inputStyle, width: '180px' }} value={nu.whatsapp_phone_id} onChange={e => setNu({ ...nu, whatsapp_phone_id: e.target.value })} placeholder="1135649372965076" /></Field>
        <Field label="WhatsApp Access Token"><input style={{ ...inputStyle, width: '260px' }} type="password" value={nu.whatsapp_access_token} onChange={e => setNu({ ...nu, whatsapp_access_token: e.target.value })} placeholder="EAAG..." /></Field>
        <button type="submit" disabled={creating} style={{ ...btn('#C8FF00', '#000'), padding: '10px 18px', fontSize: '13px' }}>
          {creating ? 'Creando…' : '+ Crear tenant'}
        </button>
      </form>

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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <label style={{ fontSize: '11px', fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</label>
      {children}
    </div>
  );
}
