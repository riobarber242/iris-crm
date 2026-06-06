'use client';

import React, { useEffect, useState } from 'react';

type Agent = {
  id: string;
  username: string;
  name: string;
  email: string | null;
  role: 'admin' | 'agent';
  active: boolean;
  schedule_start: string | null;
  schedule_end: string | null;
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

function hhmm(t: string | null) { return t ? t.slice(0, 5) : ''; }

export default function AgentsClient() {
  const [agents,  setAgents]  = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');

  // create form
  const [nu, setNu] = useState({ username: '', name: '', email: '', password: '', role: 'agent', schedule_start: '', schedule_end: '' });
  const [creating, setCreating] = useState(false);

  // inline edit
  const [editId,   setEditId]   = useState<string | null>(null);
  const [draft,    setDraft]    = useState<Partial<Agent>>({});
  // reset password
  const [resetId,  setResetId]  = useState<string | null>(null);
  const [newPass,  setNewPass]  = useState('');

  async function fetchAgents() {
    try {
      const res = await fetch('/api/agents');
      if (res.ok) setAgents(await res.json());
      else setError((await res.json().catch(() => ({}))).error ?? 'Error cargando agentes');
    } catch { setError('Error de red'); }
    finally { setLoading(false); }
  }

  useEffect(() => { fetchAgents(); }, []);

  async function createAgent(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setCreating(true);
    try {
      const res = await fetch('/api/agents', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(nu),
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok) {
        setNu({ username: '', name: '', email: '', password: '', role: 'agent', schedule_start: '', schedule_end: '' });
        fetchAgents();
      } else {
        setError(d.error ?? 'No se pudo crear');
      }
    } catch { setError('Error de red'); }
    finally { setCreating(false); }
  }

  function startEdit(a: Agent) {
    setEditId(a.id);
    setDraft({ name: a.name, email: a.email ?? '', role: a.role, schedule_start: hhmm(a.schedule_start), schedule_end: hhmm(a.schedule_end) });
  }

  async function deleteAgent(a: Agent) {
    if (!confirm(`¿Eliminar al operador "${a.name}"? Sus chats quedarán sin asignar. Esta acción no se puede deshacer.`)) return;
    setError('');
    const res = await fetch(`/api/agents/${a.id}`, { method: 'DELETE' });
    const d = await res.json().catch(() => ({}));
    if (res.ok) fetchAgents();
    else setError(d.error ?? 'No se pudo eliminar');
  }

  async function saveEdit(id: string) {
    setError('');
    const res = await fetch(`/api/agents/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft),
    });
    const d = await res.json().catch(() => ({}));
    if (res.ok) { setEditId(null); fetchAgents(); }
    else setError(d.error ?? 'No se pudo guardar');
  }

  async function toggleActive(a: Agent) {
    setError('');
    const res = await fetch(`/api/agents/${a.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: !a.active }),
    });
    const d = await res.json().catch(() => ({}));
    if (res.ok) fetchAgents();
    else setError(d.error ?? 'No se pudo cambiar el estado');
  }

  async function resetPassword(id: string) {
    setError('');
    const res = await fetch(`/api/agents/${id}/password`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: newPass }),
    });
    const d = await res.json().catch(() => ({}));
    if (res.ok) { setResetId(null); setNewPass(''); alert('Contraseña actualizada'); }
    else setError(d.error ?? 'No se pudo resetear');
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

      {error && (
        <div style={{ background: '#FFE5E5', color: '#CC3333', borderRadius: '10px', padding: '10px 14px', fontSize: '13px', fontWeight: 600 }}>
          {error}
        </div>
      )}

      {/* Crear agente */}
      <form onSubmit={createAgent} style={{ background: '#fff', borderRadius: '16px', padding: '18px', boxShadow: '0 1px 8px rgba(0,0,0,0.06)', display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'flex-end' }}>
        <Field label="Usuario"><input style={inputStyle} value={nu.username} onChange={e => setNu({ ...nu, username: e.target.value })} placeholder="matias" /></Field>
        <Field label="Nombre"><input style={inputStyle} value={nu.name} onChange={e => setNu({ ...nu, name: e.target.value })} placeholder="Matías" /></Field>
        <Field label="Email"><input style={inputStyle} type="email" value={nu.email} onChange={e => setNu({ ...nu, email: e.target.value })} placeholder="matias@iris.com" /></Field>
        <Field label="Contraseña"><input style={inputStyle} type="password" value={nu.password} onChange={e => setNu({ ...nu, password: e.target.value })} placeholder="••••••" /></Field>
        <Field label="Rol">
          <select style={inputStyle} value={nu.role} onChange={e => setNu({ ...nu, role: e.target.value })}>
            <option value="agent">Agente</option>
            <option value="admin">Admin</option>
          </select>
        </Field>
        <Field label="Desde"><input style={inputStyle} type="time" value={nu.schedule_start} onChange={e => setNu({ ...nu, schedule_start: e.target.value })} /></Field>
        <Field label="Hasta"><input style={inputStyle} type="time" value={nu.schedule_end} onChange={e => setNu({ ...nu, schedule_end: e.target.value })} /></Field>
        <button type="submit" disabled={creating} style={{ ...btn('#C8FF00', '#000'), padding: '10px 18px', fontSize: '13px' }}>
          {creating ? 'Creando…' : '+ Crear agente'}
        </button>
      </form>

      {/* Tabla */}
      {loading ? (
        <p style={{ textAlign: 'center', color: '#999', fontSize: '14px' }}>Cargando agentes…</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1.3fr 0.7fr 1.1fr 0.7fr 1.7fr', gap: '10px', padding: '8px 16px', fontSize: '11px', fontWeight: 700, color: '#aaa', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            <span>Usuario</span><span>Nombre</span><span>Email</span><span>Rol</span><span>Horario</span><span>Estado</span><span>Acciones</span>
          </div>

          {agents.map((a) => {
            const editing = editId === a.id;
            return (
              <div key={a.id} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1.3fr 0.7fr 1.1fr 0.7fr 1.7fr', gap: '10px', alignItems: 'center', background: '#fff', borderRadius: '12px', padding: '12px 16px', boxShadow: '0 1px 6px rgba(0,0,0,0.05)', opacity: a.active ? 1 : 0.55 }}>
                {/* usuario */}
                <span style={{ fontSize: '13px', fontWeight: 700, color: '#111' }}>{a.username}</span>

                {/* nombre */}
                {editing
                  ? <input style={inputStyle} value={draft.name ?? ''} onChange={e => setDraft({ ...draft, name: e.target.value })} />
                  : <span style={{ fontSize: '13px', color: '#333' }}>{a.name}</span>}

                {/* email */}
                {editing
                  ? <input style={inputStyle} type="email" value={draft.email ?? ''} onChange={e => setDraft({ ...draft, email: e.target.value })} placeholder="email@iris.com" />
                  : <span style={{ fontSize: '12px', color: a.email ? '#555' : '#ccc' }}>{a.email || '—'}</span>}

                {/* rol */}
                {editing
                  ? <select style={inputStyle} value={draft.role} onChange={e => setDraft({ ...draft, role: e.target.value as Agent['role'] })}>
                      <option value="agent">Agente</option><option value="admin">Admin</option>
                    </select>
                  : <span style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', color: a.role === 'admin' ? '#7da000' : '#888' }}>{a.role === 'admin' ? 'Admin' : 'Agente'}</span>}

                {/* horario */}
                {editing
                  ? <span style={{ display: 'flex', gap: '4px' }}>
                      <input style={{ ...inputStyle, width: '70px' }} type="time" value={draft.schedule_start ?? ''} onChange={e => setDraft({ ...draft, schedule_start: e.target.value })} />
                      <input style={{ ...inputStyle, width: '70px' }} type="time" value={draft.schedule_end ?? ''} onChange={e => setDraft({ ...draft, schedule_end: e.target.value })} />
                    </span>
                  : <span style={{ fontSize: '12px', color: '#666' }}>{a.schedule_start ? `${hhmm(a.schedule_start)}–${hhmm(a.schedule_end)}` : '—'}</span>}

                {/* estado */}
                <span style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', color: a.active ? '#1a8a1a' : '#bbb' }}>
                  {a.active ? 'Activo' : 'Inactivo'}
                </span>

                {/* acciones */}
                <span style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                  {editing ? (
                    <>
                      <button onClick={() => saveEdit(a.id)} style={btn('#C8FF00', '#000')}>Guardar</button>
                      <button onClick={() => setEditId(null)} style={btn('#F0F0F0', '#666')}>Cancelar</button>
                    </>
                  ) : resetId === a.id ? (
                    <span style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                      <input style={{ ...inputStyle, width: '110px' }} type="text" value={newPass} onChange={e => setNewPass(e.target.value)} placeholder="nueva pass" autoFocus />
                      <button onClick={() => resetPassword(a.id)} style={btn('#C8FF00', '#000')}>OK</button>
                      <button onClick={() => { setResetId(null); setNewPass(''); }} style={btn('#F0F0F0', '#666')}>✕</button>
                    </span>
                  ) : (
                    <>
                      <button onClick={() => startEdit(a)} style={btn('#F0F0F0', '#333')}>Editar</button>
                      <button onClick={() => toggleActive(a)} style={btn(a.active ? '#FFE5E5' : '#E8F5E9', a.active ? '#CC3333' : '#1a8a1a')}>
                        {a.active ? 'Desactivar' : 'Activar'}
                      </button>
                      <button onClick={() => { setResetId(a.id); setNewPass(''); }} style={btn('#F0F0F0', '#333')}>Reset pass</button>
                      <button onClick={() => deleteAgent(a)} style={btn('#FFE5E5', '#CC3333')}>Eliminar</button>
                    </>
                  )}
                </span>
              </div>
            );
          })}
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
