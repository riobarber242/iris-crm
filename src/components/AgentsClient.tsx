'use client';

import React, { useEffect, useState } from 'react';
import { useAuth } from './AuthProvider';

type Agent = {
  id: string;
  username: string;
  name: string;
  email: string | null;
  role: 'admin' | 'agent' | 'operator';
  active: boolean;
  schedule_start: string | null;
  schedule_end: string | null;
  system_prompt: string | null;
  can_see_top_clients: boolean;
  can_see_campaigns: boolean;
  session_timeout_enabled: boolean;
  session_timeout_minutes: number;
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
  const { agent: me } = useAuth();
  // Solo el admin elige el rol al crear/editar. El agente gestiona únicamente
  // operadores de su tenant, así que el rol queda fijo en 'operator'.
  const isAdmin = me?.role === 'admin';
  const [agents,  setAgents]  = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');

  // create form
  const [nu, setNu] = useState({ username: '', name: '', email: '', password: '', role: 'agent', schedule_start: '', schedule_end: '', can_see_top_clients: false, can_see_campaigns: false, session_timeout_enabled: true, session_timeout_minutes: 20 });
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

  // El agente solo crea operadores → fijamos el rol en cuanto conocemos el rol propio.
  useEffect(() => { if (me && !isAdmin) setNu(n => ({ ...n, role: 'operator' })); }, [me, isAdmin]);

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
        setNu({ username: '', name: '', email: '', password: '', role: isAdmin ? 'agent' : 'operator', schedule_start: '', schedule_end: '', can_see_top_clients: false, can_see_campaigns: false, session_timeout_enabled: true, session_timeout_minutes: 20 });
        fetchAgents();
      } else {
        setError(d.error ?? 'No se pudo crear');
      }
    } catch { setError('Error de red'); }
    finally { setCreating(false); }
  }

  function startEdit(a: Agent) {
    setEditId(a.id);
    setDraft({ name: a.name, email: a.email ?? '', role: a.role, schedule_start: hhmm(a.schedule_start), schedule_end: hhmm(a.schedule_end), system_prompt: a.system_prompt ?? '', can_see_top_clients: a.can_see_top_clients, can_see_campaigns: a.can_see_campaigns, session_timeout_enabled: a.session_timeout_enabled, session_timeout_minutes: a.session_timeout_minutes });
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
        {isAdmin && (
          <Field label="Rol">
            <select style={inputStyle} value={nu.role} onChange={e => setNu({ ...nu, role: e.target.value })}>
              <option value="agent">Agente</option>
              <option value="operator">Operador</option>
              <option value="admin">Admin</option>
            </select>
          </Field>
        )}
        <Field label="Desde"><input style={inputStyle} type="time" value={nu.schedule_start} onChange={e => setNu({ ...nu, schedule_start: e.target.value })} /></Field>
        <Field label="Hasta"><input style={inputStyle} type="time" value={nu.schedule_end} onChange={e => setNu({ ...nu, schedule_end: e.target.value })} /></Field>
        {nu.role === 'operator' && (
          <Field label="Permisos">
            <span style={{ display: 'flex', gap: '14px', alignItems: 'center', height: '34px' }}>
              <PermCheck label="Top Clientes" checked={nu.can_see_top_clients} onChange={v => setNu({ ...nu, can_see_top_clients: v })} />
              <PermCheck label="Campañas" checked={nu.can_see_campaigns} onChange={v => setNu({ ...nu, can_see_campaigns: v })} />
            </span>
          </Field>
        )}
        {nu.role === 'operator' && (
          <Field label="Cierre por inactividad">
            <span style={{ display: 'flex', gap: '10px', alignItems: 'center', height: '34px' }}>
              <PermCheck label="Activado" checked={nu.session_timeout_enabled} onChange={v => setNu({ ...nu, session_timeout_enabled: v })} />
              {nu.session_timeout_enabled && (
                <>
                  <input style={{ ...inputStyle, width: '64px' }} type="number" min={1} max={1440} value={nu.session_timeout_minutes} onChange={e => setNu({ ...nu, session_timeout_minutes: Number(e.target.value) })} />
                  <span style={{ fontSize: '12px', color: '#888' }}>min</span>
                </>
              )}
            </span>
          </Field>
        )}
        <button type="submit" disabled={creating} style={{ ...btn('#C8FF00', '#000'), padding: '10px 18px', fontSize: '13px' }}>
          {creating ? 'Creando…' : '+ Crear agente'}
        </button>
      </form>

      {/* Tabla. En mobile scrollea horizontal (minWidth interno); en desktop
          no cambia nada porque el contenedor ya es más ancho. */}
      {loading ? (
        <p style={{ textAlign: 'center', color: '#999', fontSize: '14px' }}>Cargando agentes…</p>
      ) : (
        <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
        <div className="agents-table" style={{ display: 'flex', flexDirection: 'column', gap: '8px', minWidth: '860px' }}>
          <div className="agents-head" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1.3fr 0.7fr 1.1fr 0.7fr 1.7fr', gap: '10px', padding: '8px 16px', fontSize: '11px', fontWeight: 700, color: '#aaa', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            <span>Usuario</span><span>Nombre</span><span>Email</span><span>Rol</span><span>Horario</span><span>Estado</span><span>Acciones</span>
          </div>

          {agents.map((a) => {
            const editing = editId === a.id;
            // El system prompt solo lo edita un admin, o el propio operador sobre su perfil.
            const canEditPrompt = me?.role === 'admin' || me?.id === a.id;
            return (
              <div key={a.id} className="agents-row" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1.3fr 0.7fr 1.1fr 0.7fr 1.7fr', gap: '10px', alignItems: 'center', background: '#fff', borderRadius: '12px', padding: '12px 16px', boxShadow: '0 1px 6px rgba(0,0,0,0.05)', opacity: a.active ? 1 : 0.55 }}>
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

                {/* rol — el selector solo lo ve el admin; el agente gestiona operadores fijos */}
                {editing && isAdmin
                  ? <select style={inputStyle} value={draft.role} onChange={e => setDraft({ ...draft, role: e.target.value as Agent['role'] })}>
                      <option value="agent">Agente</option><option value="operator">Operador</option><option value="admin">Admin</option>
                    </select>
                  : <span style={{ display: 'flex', flexDirection: 'column', gap: '3px', alignItems: 'flex-start' }}>
                      <span style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', color: a.role === 'admin' ? '#7da000' : '#888' }}>{a.role === 'admin' ? 'Admin' : a.role === 'operator' ? 'Operador' : 'Agente'}</span>
                      {a.role === 'operator' && (
                        <span style={{ display: 'flex', gap: '3px', flexWrap: 'wrap' }}>
                          {a.can_see_top_clients && <PermPill label="Top" />}
                          {a.can_see_campaigns && <PermPill label="Camp" />}
                          <PermPill label={a.session_timeout_enabled ? `⏱ ${a.session_timeout_minutes}m` : '⏱ off'} />
                        </span>
                      )}
                    </span>}

                {/* horario */}
                {editing
                  ? <span className="ag-horario" style={{ display: 'flex', gap: '4px' }}>
                      <input style={{ ...inputStyle, width: '70px' }} type="time" value={draft.schedule_start ?? ''} onChange={e => setDraft({ ...draft, schedule_start: e.target.value })} />
                      <input style={{ ...inputStyle, width: '70px' }} type="time" value={draft.schedule_end ?? ''} onChange={e => setDraft({ ...draft, schedule_end: e.target.value })} />
                    </span>
                  : <span className="ag-horario" style={{ fontSize: '12px', color: '#666' }}>{a.schedule_start ? `${hhmm(a.schedule_start)}–${hhmm(a.schedule_end)}` : '—'}</span>}

                {/* estado */}
                <span style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', color: a.active ? '#1a8a1a' : '#bbb' }}>
                  {a.active ? 'Activo' : 'Inactivo'}
                </span>

                {/* acciones */}
                <span className="ag-actions" style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
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

                {/* permisos del operador (full-width, solo al editar un operator) */}
                {editing && draft.role === 'operator' && (
                  <div style={{ gridColumn: '1 / -1', display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '6px' }}>
                    <label style={{ fontSize: '11px', fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      Permisos del operador
                    </label>
                    <span style={{ display: 'flex', gap: '18px', alignItems: 'center' }}>
                      <PermCheck label="Ver Top Clientes" checked={!!draft.can_see_top_clients} onChange={v => setDraft({ ...draft, can_see_top_clients: v })} />
                      <PermCheck label="Ver Campañas" checked={!!draft.can_see_campaigns} onChange={v => setDraft({ ...draft, can_see_campaigns: v })} />
                    </span>
                    <label style={{ fontSize: '11px', fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: '6px' }}>
                      Cierre de sesión por inactividad
                    </label>
                    <span style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                      <PermCheck label="Activado" checked={draft.session_timeout_enabled ?? true} onChange={v => setDraft({ ...draft, session_timeout_enabled: v })} />
                      {(draft.session_timeout_enabled ?? true) ? (
                        <>
                          <input style={{ ...inputStyle, width: '70px' }} type="number" min={1} max={1440} value={draft.session_timeout_minutes ?? 20} onChange={e => setDraft({ ...draft, session_timeout_minutes: Number(e.target.value) })} />
                          <span style={{ fontSize: '12px', color: '#888' }}>minutos sin actividad</span>
                        </>
                      ) : (
                        <span style={{ fontSize: '12px', color: '#888' }}>La sesión de este operador no expira nunca.</span>
                      )}
                    </span>
                  </div>
                )}

                {/* system prompt (full-width, solo al editar) */}
                {editing && canEditPrompt && (
                  <div style={{ gridColumn: '1 / -1', display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '6px' }}>
                    <label style={{ fontSize: '11px', fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      Instrucciones del bot (system prompt)
                    </label>
                    <textarea
                      style={{ ...inputStyle, minHeight: '90px', resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }}
                      value={draft.system_prompt ?? ''}
                      onChange={e => setDraft({ ...draft, system_prompt: e.target.value })}
                      placeholder="Ej: Sos un asistente amable que trabaja para una empresa de recargas llamada Iris. Siempre saludá al cliente por su nombre y ofrecé ayuda para completar su recarga."
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
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

function PermCheck({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', color: '#333', cursor: 'pointer', whiteSpace: 'nowrap' }}>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} style={{ width: '16px', height: '16px', accentColor: '#1a8a1a', cursor: 'pointer' }} />
      {label}
    </label>
  );
}

function PermPill({ label }: { label: string }) {
  return (
    <span style={{ background: '#E8F5E9', color: '#1a8a1a', fontSize: '9px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.04em', borderRadius: '999px', padding: '2px 6px', lineHeight: 1 }}>
      {label}
    </span>
  );
}
