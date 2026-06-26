"use client";

import React, { useState, useEffect } from 'react';
import { useAuth } from './AuthProvider';

type AgentOption = { id: string; name: string; active: boolean };

const PROVINCIAS = [
  'CABA', 'Buenos Aires', 'Catamarca', 'Chaco', 'Chubut', 'Córdoba',
  'Corrientes', 'Entre Ríos', 'Formosa', 'Jujuy', 'La Pampa', 'La Rioja',
  'Mendoza', 'Misiones', 'Neuquén', 'Río Negro', 'Salta', 'San Juan',
  'San Luis', 'Santa Cruz', 'Santa Fe', 'Santiago del Estero',
  'Tierra del Fuego', 'Tucumán',
];

const STATUS_OPTIONS = [
  { value: 'nuevo',          label: 'Nuevo' },
  { value: 'cliente_activo', label: 'Cliente activo' },
  { value: 'inactivo',       label: 'Inactivo' },
  { value: 'en_proceso',     label: 'En proceso' },
];

const STATUS_COLOR: Record<string, { bg: string; fg: string }> = {
  nuevo:          { bg: '#F0F0F0', fg: '#888' },
  cliente_activo: { bg: '#C8FF00', fg: '#000' },
  inactivo:       { bg: '#888',    fg: '#fff' },
  en_proceso:     { bg: '#C8FF00', fg: '#000' },
};

const BOT_STATE_LABEL: Record<string, string> = {
  greeting:          'Saludó',
  asked_intention:   'Esperando intención',
  waiting_screenshot:'Esperando screenshot',
  asked_if_loader:   'Preguntó si carga',
  asked_name:        'Esperando nombre',
  done:              'Flujo completado',
  en_proceso:        'Flujo completado',
  known_client:      'Cliente reconocido',
};

// Sugiere un username de casino a partir del nombre del contacto:
// <primeras 5 letras del nombre, sin espacios ni acentos, lowercase> + "1js".
// Si no hay nombre usable, cae a "jugador".
function suggestUsername(name?: string | null): string {
  const slug = (name ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')  // saca acentos
    .toLowerCase().replace(/[^a-z0-9]/g, '')           // solo alfanumérico
    .slice(0, 5);
  return `${slug || 'jugador'}1js`;
}

export default function ContactHeader({
  contactId,
  phone,
  contactName,
  casinoDepositEnabled,
  initialCasinoUsername,
  initialBlocked,
  initialStatus,
  conversationState,
  initialNotes,
  initialProvincia,
  initialAssignedAgentId,
  recargasCount,
  recargasMonto,
}: {
  contactId:              string;
  phone:                  string;
  contactName?:           string | null;
  casinoDepositEnabled?:  boolean;
  initialCasinoUsername?: string | null;
  initialBlocked?:        boolean;
  initialStatus?:         string | null;
  conversationState?:     string | null;
  initialNotes?:          string;
  initialProvincia?:      string | null;
  initialAssignedAgentId?: string | null;
  recargasCount?:         number;
  recargasMonto?:         number;
}) {
  const [casinoUser,    setCasinoUser]    = useState(initialCasinoUsername ?? '');
  const [editing,       setEditing]       = useState(false);
  const [loading,       setLoading]       = useState(false);
  const [blocked,       setBlocked]       = useState(initialBlocked ?? false);
  const [status,        setStatus]        = useState(initialStatus ?? 'nuevo');
  const [statusLoading, setStatusLoading] = useState(false);
  const [notes,         setNotes]         = useState(initialNotes ?? '');
  const [notesEditing,  setNotesEditing]  = useState(false);
  const [notesSaving,   setNotesSaving]   = useState(false);
  const [botState,      setBotState]      = useState(conversationState ?? null);
  const [resetLoading,  setResetLoading]  = useState(false);
  const [provincia,     setProvincia]     = useState(initialProvincia ?? '');
  const [assignedAgent, setAssignedAgent] = useState(initialAssignedAgentId ?? '');
  const [agents,        setAgents]        = useState<AgentOption[]>([]);

  // Header colapsable (mobile): la fila compacta queda siempre visible y el resto
  // se expande/contrae. Default colapsado para que el chat ocupe más alto.
  const [expanded, setExpanded] = useState(false);

  // ── Crear usuario casino ──
  const [createOpen,    setCreateOpen]    = useState(false);
  const [createUser,    setCreateUser]    = useState(() => suggestUsername(contactName));
  const [creating,      setCreating]      = useState(false);
  const [createError,   setCreateError]   = useState('');
  // Credenciales del usuario recién creado (se muestran una sola vez).
  const [created,       setCreated]       = useState<{ username: string; password: string } | null>(null);

  const { agent } = useAuth();
  const isAdmin = agent?.role === 'admin';

  // El admin necesita la lista de operadores para reasignar el chat.
  useEffect(() => {
    if (!isAdmin) return;
    fetch('/api/agents')
      .then((r) => (r.ok ? r.json() : []))
      .then((d: AgentOption[]) => setAgents(Array.isArray(d) ? d : []))
      .catch(() => {});
  }, [isAdmin]);

  async function saveAssignedAgent(value: string) {
    setAssignedAgent(value);
    await fetch('/api/conversations', {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ contactId, assigned_agent_id: value || null }),
    }).catch(() => {});
  }

  async function handleStatusChange(newStatus: string) {
    setStatusLoading(true);
    try {
      await fetch('/api/conversations', {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ contactId, status: newStatus }),
      });
      setStatus(newStatus);
    } catch {}
    setStatusLoading(false);
  }

  async function handleBlock() {
    if (!confirm('¿Seguro que querés bloquear este contacto? El bot dejará de responderle.')) return;
    await fetch('/api/conversations', {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ contactId, blocked: true }),
    });
    setBlocked(true);
    window.location.reload();
  }

  async function handleUnblock() {
    await fetch('/api/conversations', {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ contactId, blocked: false }),
    });
    setBlocked(false);
    window.location.reload();
  }

  async function save() {
    setLoading(true);
    try {
      const res = await fetch('/api/conversations', {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ contactId, casino_username: casinoUser }),
      });
      if (res.ok) setEditing(false);
    } catch {}
    setLoading(false);
  }

  async function createCasinoPlayer() {
    const suggested = createUser.trim().toLowerCase();
    if (!suggested) { setCreateError('Ingresá un nombre de usuario'); return; }
    setCreating(true);
    setCreateError('');
    try {
      const res = await fetch('/api/casino/create-player', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ contactId, suggestedUsername: suggested }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        setCreated({ username: data.username, password: data.password });
        setCasinoUser(data.username);       // refleja el usuario en el header
      } else {
        setCreateError(data.error || 'No se pudo crear el usuario en el casino');
      }
    } catch {
      setCreateError('Error de red');
    }
    setCreating(false);
  }

  async function resetBot() {
    if (!confirm('¿Reiniciar el flujo del bot? El bot volverá a atender a este contacto desde cero.')) return;
    setResetLoading(true);
    try {
      await fetch('/api/conversations', {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ contactId, conversation_state: null, status: 'nuevo' }),
      });
      setBotState(null);
      setStatus('nuevo');
    } catch {}
    setResetLoading(false);
  }

  async function saveProvincia(value: string) {
    setProvincia(value);
    await fetch('/api/conversations', {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ contactId, provincia: value || null }),
    }).catch(() => {});
  }

  async function saveNotes() {
    setNotesSaving(true);
    try {
      await fetch('/api/conversations', {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ contactId, notes }),
      });
      setNotesEditing(false);
    } catch {}
    setNotesSaving(false);
  }

  const display  = casinoUser || phone;
  const initial  = display.charAt(0).toUpperCase();
  const botLabel = botState ? (BOT_STATE_LABEL[botState] ?? botState) : null;
  const hasRecargas = (recargasCount ?? 0) > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>

      {/* ── Banner de contacto bloqueado ── */}
      {blocked && (
        <div style={{
          background: '#fff0f0', border: '1px solid #f08080',
          borderRadius: '12px', padding: '10px 16px',
          display: 'flex', alignItems: 'center', gap: '10px',
        }}>
          <span style={{ fontSize: '16px' }}>🚫</span>
          <p style={{ fontSize: '13px', color: '#c0392b', fontWeight: 700, margin: 0 }}>
            Este contacto está bloqueado — el bot no le responde y no recibirá mensajes automáticos.
          </p>
        </div>
      )}

      {/* ── Fila principal colapsada (siempre visible) ── */}
      <div style={{
        background: '#FFFFFF', borderRadius: '16px', padding: '6px 12px',
        boxShadow: '0 2px 16px rgba(0,0,0,0.07)', display: 'flex',
        alignItems: 'center', gap: '12px', width: '100%',
      }}>
        {/* Avatar */}
        <div style={{
          width: '32px', height: '32px', borderRadius: '50%', background: '#C8FF00',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontWeight: 800, fontSize: '14px', color: '#000', flexShrink: 0,
        }}>
          {initial}
        </div>

        {/* Nombre/usuario casino + teléfono */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {casinoUser && (
            <p style={{ fontSize: '15px', fontWeight: 800, color: '#000', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              🎰 {casinoUser}
            </p>
          )}
          <p style={{ fontSize: '12px', color: '#999', margin: casinoUser ? '2px 0 0 0' : 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{phone}</p>
        </div>

        {/* Pill de estado (editable, STATUS_COLOR) */}
        <select
          value={status}
          onChange={(e) => handleStatusChange(e.target.value)}
          disabled={statusLoading}
          style={{
            background:   (STATUS_COLOR[status] ?? STATUS_COLOR.nuevo).bg,
            color:        (STATUS_COLOR[status] ?? STATUS_COLOR.nuevo).fg,
            fontWeight:   700,
            fontSize:     '12px',
            border:       'none',
            borderRadius: '8px',
            padding:      '4px 10px',
            cursor:       statusLoading ? 'not-allowed' : 'pointer',
            opacity:      statusLoading ? 0.6 : 1,
            outline:      'none',
            flexShrink:   0,
          }}
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>

        {/* Toggle expandir/contraer (se oculta en desktop vía CSS: ahí va todo expandido) */}
        <button
          className="ch-toggle"
          onClick={() => setExpanded((v) => !v)}
          title={expanded ? 'Contraer' : 'Expandir'}
          aria-label={expanded ? 'Contraer' : 'Expandir'}
          style={{
            background: '#F0F0F0', color: '#555', border: 'none', borderRadius: '8px',
            width: '30px', height: '30px', display: 'inline-flex', alignItems: 'center',
            justifyContent: 'center', cursor: 'pointer', fontSize: '14px', fontWeight: 800, flexShrink: 0,
          }}
        >
          {expanded ? '∧' : '∨'}
        </button>
      </div>

      {/* ── Contenido expandible (recargas, provincia, operador, botones, notas) ── */}
      <div className="ch-expandable" style={{
        maxHeight: expanded ? '2000px' : '0',
        overflow: 'hidden',
        transition: 'max-height 0.3s ease',
        display: 'flex', flexDirection: 'column', gap: '10px',
      }}>
        {/* Tarjeta de controles del contacto */}
        <div style={{
          background: '#FFFFFF', borderRadius: '16px', padding: '16px 20px',
          boxShadow: '0 2px 16px rgba(0,0,0,0.07)',
        }}>
          {editing ? (
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                value={casinoUser}
                onChange={(e) => setCasinoUser(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }}
                placeholder="Usuario casino"
                autoFocus
                style={{
                  background: '#F5F5F5', border: 'none', borderRadius: '10px',
                  padding: '8px 12px', fontSize: '14px', color: '#000', outline: 'none', minWidth: '180px',
                }}
              />
              <button disabled={loading} onClick={save} style={{
                background: '#C8FF00', color: '#000', fontWeight: 700, border: 'none',
                borderRadius: '10px', padding: '8px 16px', cursor: 'pointer', fontSize: '13px',
              }}>
                Guardar
              </button>
              <button onClick={() => setEditing(false)} style={{
                background: '#F0F0F0', color: '#666', fontWeight: 600, border: 'none',
                borderRadius: '10px', padding: '8px 16px', cursor: 'pointer', fontSize: '13px',
              }}>
                Cancelar
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
              {hasRecargas && (
                <p style={{ fontSize: '12px', color: '#1a7a3a', fontWeight: 700, margin: 0, width: '100%' }}>
                  {recargasCount} recarga{(recargasCount ?? 0) !== 1 ? 's' : ''} verificada{(recargasCount ?? 0) !== 1 ? 's' : ''} · ${(recargasMonto ?? 0).toLocaleString('es-AR')} total
                </p>
              )}

              {/* Provincia selector */}
              <select
                value={provincia}
                onChange={(e) => saveProvincia(e.target.value)}
                style={{
                  background:   '#F5F5F5',
                  color:        provincia ? '#333' : '#aaa',
                  fontWeight:   600,
                  fontSize:     '12px',
                  border:       'none',
                  borderRadius: '8px',
                  padding:      '4px 10px',
                  cursor:       'pointer',
                  outline:      'none',
                }}
              >
                <option value="">📍 Provincia</option>
                {PROVINCIAS.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>

              {/* Asignar operador (solo admin) */}
              {isAdmin && (
                <select
                  value={assignedAgent}
                  onChange={(e) => saveAssignedAgent(e.target.value)}
                  title="Asignar este chat a un operador"
                  style={{
                    background:   assignedAgent ? '#eef6ff' : '#F5F5F5',
                    color:        assignedAgent ? '#1f6fd6' : '#aaa',
                    fontWeight:   700,
                    fontSize:     '12px',
                    border:       assignedAgent ? '1px solid #c5dcf5' : '1px solid #eee',
                    borderRadius: '8px',
                    padding:      '4px 10px',
                    cursor:       'pointer',
                    outline:      'none',
                  }}
                >
                  <option value="">👤 Sin asignar</option>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.active ? a.name : `${a.name} (inactivo)`}
                    </option>
                  ))}
                </select>
              )}

              {/* Bot state badge + reset */}
              {botLabel ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span style={{
                    background: '#f0f4ff', color: '#3b5bdb',
                    fontSize: '11px', fontWeight: 700,
                    borderRadius: '8px', padding: '4px 10px',
                    border: '1px solid #c5cff5', whiteSpace: 'nowrap',
                  }}>
                    🤖 {botLabel}
                  </span>
                  <button
                    onClick={resetBot}
                    disabled={resetLoading}
                    title="Reiniciar flujo del bot"
                    style={{
                      background: resetLoading ? '#e0e0e0' : '#fff0f0',
                      color: '#c0392b', fontSize: '11px', fontWeight: 700,
                      border: '1px solid #f08080', borderRadius: '8px',
                      padding: '4px 8px', cursor: resetLoading ? 'not-allowed' : 'pointer',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {resetLoading ? '...' : '↺ Reiniciar bot'}
                  </button>
                </div>
              ) : (
                <span style={{
                  background: '#f5f5f5', color: '#bbb',
                  fontSize: '11px', fontWeight: 600,
                  borderRadius: '8px', padding: '4px 10px',
                  border: '1px solid #eee', whiteSpace: 'nowrap',
                }}>
                  🤖 Sin iniciar
                </span>
              )}

              {/* Crear usuario en el casino: solo si el tenant lo tiene activado
                  y el contacto todavía no tiene usuario asignado. */}
              {casinoDepositEnabled && !casinoUser && (
                <button
                  onClick={() => { setCreated(null); setCreateError(''); setCreateUser(suggestUsername(contactName)); setCreateOpen(true); }}
                  style={{
                    background: '#1a1a1a', color: '#C8FF00', fontWeight: 800, border: 'none',
                    borderRadius: '8px', padding: '4px 12px', cursor: 'pointer', fontSize: '12px',
                  }}
                >
                  🎰 Crear usuario casino
                </button>
              )}

              <button onClick={() => setEditing(true)} style={{
                background: '#F0F0F0', color: '#666', fontWeight: 700, border: 'none',
                borderRadius: '8px', padding: '4px 12px', cursor: 'pointer', fontSize: '12px',
              }}>
                {casinoUser ? 'Editar usuario' : '+ Asignar usuario'}
              </button>
              {blocked ? (
                <button onClick={handleUnblock} style={{
                  background: '#22C55E', color: '#fff', fontWeight: 700, border: 'none',
                  borderRadius: '8px', padding: '4px 12px', cursor: 'pointer', fontSize: '12px',
                }}>
                  ✅ Desbloqueado
                </button>
              ) : (
                <button onClick={handleBlock} style={{
                  background: '#FF4444', color: '#fff', fontWeight: 700, border: 'none',
                  borderRadius: '8px', padding: '4px 12px', cursor: 'pointer', fontSize: '12px',
                }}>
                  🚫 Bloquear
                </button>
              )}
            </div>
          )}
        </div>

      {/* ── Notas internas ── */}
      <div style={{
        background: '#FFFFFF', borderRadius: '14px', padding: '14px 18px',
        boxShadow: '0 1px 8px rgba(0,0,0,0.05)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
          <p style={{ fontSize: '11px', fontWeight: 700, color: '#aaa', textTransform: 'uppercase', letterSpacing: '0.08em', margin: 0 }}>
            Notas internas
          </p>
          {!notesEditing && (
            <button onClick={() => setNotesEditing(true)} style={{
              background: 'transparent', color: '#888', fontSize: '11px', fontWeight: 700,
              border: '1px solid #e0e0e0', borderRadius: '6px', padding: '2px 8px', cursor: 'pointer',
            }}>
              ✏ Editar
            </button>
          )}
        </div>

        {notesEditing ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="Notas sobre este contacto (solo visibles para operadores)..."
              autoFocus
              style={{
                width: '100%', background: '#F5F5F5', border: 'none', borderRadius: '10px',
                padding: '10px 14px', fontSize: '13px', color: '#000', outline: 'none',
                resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5, boxSizing: 'border-box',
              }}
            />
            <div style={{ display: 'flex', gap: '8px' }}>
              <button onClick={saveNotes} disabled={notesSaving} style={{
                background: '#C8FF00', color: '#000', fontWeight: 700, fontSize: '12px',
                border: 'none', borderRadius: '8px', padding: '6px 14px', cursor: notesSaving ? 'not-allowed' : 'pointer',
                opacity: notesSaving ? 0.6 : 1,
              }}>
                {notesSaving ? 'Guardando...' : 'Guardar'}
              </button>
              <button onClick={() => { setNotesEditing(false); setNotes(initialNotes ?? ''); }} style={{
                background: '#F0F0F0', color: '#666', fontWeight: 600, fontSize: '12px',
                border: 'none', borderRadius: '8px', padding: '6px 12px', cursor: 'pointer',
              }}>
                Cancelar
              </button>
            </div>
          </div>
        ) : (
          <p style={{
            fontSize: '13px', color: notes ? '#333' : '#ccc', margin: 0,
            lineHeight: 1.6, whiteSpace: 'pre-wrap',
          }}>
            {notes || 'Sin notas. Hacé clic en Editar para agregar.'}
          </p>
        )}
      </div>
      </div>

      {/* ── Modal: crear usuario en el casino ── */}
      {createOpen && (
        <div
          onClick={() => { if (!creating) setCreateOpen(false); }}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '20px',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: '#fff', borderRadius: '18px', padding: '24px', width: '100%', maxWidth: '420px',
              boxShadow: '0 12px 40px rgba(0,0,0,0.25)', display: 'flex', flexDirection: 'column', gap: '14px',
            }}
          >
            <h3 style={{ margin: 0, fontSize: '17px', fontWeight: 900, color: '#111' }}>
              🎰 Crear usuario en el casino
            </h3>

            {created ? (
              // Éxito: mostramos las credenciales una sola vez.
              <>
                <div style={{ background: '#e8fff0', border: '1px solid #b6f0c8', borderRadius: '12px', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <p style={{ margin: 0, fontSize: '13px', fontWeight: 800, color: '#1a7a3a' }}>✅ Usuario creado</p>
                  <p style={{ margin: 0, fontSize: '14px', color: '#111' }}>
                    Usuario: <b style={{ fontFamily: 'monospace' }}>{created.username}</b>
                  </p>
                  <p style={{ margin: 0, fontSize: '14px', color: '#111' }}>
                    Contraseña: <b style={{ fontFamily: 'monospace' }}>{created.password}</b>
                  </p>
                </div>
                <p style={{ margin: 0, fontSize: '12px', color: '#999' }}>
                  Anotá la contraseña: no se vuelve a mostrar.
                </p>
                <button
                  onClick={() => setCreateOpen(false)}
                  style={{ background: '#C8FF00', color: '#000', fontWeight: 800, border: 'none', borderRadius: '10px', padding: '10px', cursor: 'pointer', fontSize: '14px' }}
                >
                  Listo
                </button>
              </>
            ) : (
              <>
                <p style={{ margin: 0, fontSize: '13px', color: '#666', lineHeight: 1.5 }}>
                  Se creará un jugador en el casino con una contraseña automática. Podés editar el usuario sugerido.
                </p>
                <label style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '12px', fontWeight: 700, color: '#888' }}>
                  Usuario
                  <input
                    value={createUser}
                    onChange={(e) => setCreateUser(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !creating) createCasinoPlayer(); }}
                    autoFocus
                    style={{
                      background: '#F5F5F5', border: 'none', borderRadius: '10px',
                      padding: '10px 14px', fontSize: '15px', fontWeight: 700, color: '#000', outline: 'none',
                    }}
                  />
                </label>

                {createError && (
                  <p style={{ margin: 0, fontSize: '13px', color: '#c0392b', fontWeight: 600 }}>{createError}</p>
                )}

                <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                  <button
                    onClick={() => setCreateOpen(false)}
                    disabled={creating}
                    style={{ background: '#F0F0F0', color: '#666', fontWeight: 600, border: 'none', borderRadius: '10px', padding: '10px 16px', cursor: creating ? 'not-allowed' : 'pointer', fontSize: '13px' }}
                  >
                    Cancelar
                  </button>
                  <button
                    onClick={createCasinoPlayer}
                    disabled={creating}
                    style={{ background: '#1a1a1a', color: '#C8FF00', fontWeight: 800, border: 'none', borderRadius: '10px', padding: '10px 20px', cursor: creating ? 'not-allowed' : 'pointer', fontSize: '13px', opacity: creating ? 0.6 : 1 }}
                  >
                    {creating ? 'Creando…' : 'Crear'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

    </div>
  );
}
