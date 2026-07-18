'use client';

import React, { useEffect, useState } from 'react';

// Configuración del casino (rol 'agent' o 'admin') — Etapa 2, PR 5.
// Flujo: conectar → probar → activar. Las credenciales viven en casino_accounts
// (cifradas) vía /api/casino/account; el switch on/off es el flag
// casino_deposit_enabled. "Probar conexión" GUARDA y PRUEBA junto (endpoint del PR4,
// modo useSaved), y sella connection_verified_at. El switch "Activar depósitos" queda
// bloqueado hasta que haya una verificación OK; editar una credencial la invalida
// (fail-safe, en el front y en el backend).

// ⓘ con explicación (tooltip nativo por title).
function Info({ text }: { text: string }) {
  return (
    <span
      title={text}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: '16px', height: '16px', marginLeft: '6px', borderRadius: '50%',
        background: '#e0e0e0', color: '#555', fontSize: '11px', fontWeight: 800,
        cursor: 'help', verticalAlign: 'middle',
      }}
      aria-label={text}
    >
      ⓘ
    </span>
  );
}

export default function CasinoConfigCard() {
  // Credenciales de conexión
  const [agentUsername, setAgentUsername] = useState('');
  const [agentId, setAgentId]   = useState('');
  const [skinId, setSkinId]     = useState('');
  const [baseUrl, setBaseUrl]   = useState('');       // dominio/URL del panel (deriva skin_domain)
  const [password, setPassword] = useState('');       // vacío = no se cambia
  const [hasPassword, setHasPassword] = useState(false);

  // Mensaje al jugador
  const [playerUrl, setPlayerUrl]   = useState('');
  const [playerUrl2, setPlayerUrl2] = useState('');
  const [template, setTemplate]     = useState('');

  // Estado
  const [enabled, setEnabled]       = useState(false);
  const [verifiedAt, setVerifiedAt] = useState<string | null>(null);
  const [credsDirty, setCredsDirty] = useState(false);   // editó una credencial desde la última verificación

  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [togglingEnabled, setTogglingEnabled] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // Verificado = hay fecha sellada Y no se tocó ninguna credencial desde entonces.
  const verified = !!verifiedAt && !credsDirty;

  async function load() {
    try {
      const res = await fetch('/api/casino/account');
      if (!res.ok) { setMsg({ kind: 'err', text: 'No se pudo cargar la configuración.' }); return; }
      const j = await res.json();
      setEnabled(!!j.enabled);
      setAgentUsername(String(j.agent_username ?? ''));
      setAgentId(String(j.agent_id ?? ''));
      setSkinId(String(j.skin_id ?? ''));
      setBaseUrl(String(j.api_base_url ?? ''));
      setPlayerUrl(String(j.player_url ?? ''));
      setPlayerUrl2(String(j.player_url_2 ?? ''));
      setTemplate(String(j.credentials_template ?? ''));
      setHasPassword(!!j.has_password);
      setVerifiedAt(j.connection_verified_at ?? null);
      setCredsDirty(false);
      setPassword('');
    } catch {
      setMsg({ kind: 'err', text: 'Error de red.' });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  // onChange de una credencial de conexión → invalida la verificación en el front
  // (el backend hace lo mismo al guardar). URLs/template NO invalidan.
  function onCredChange<T>(setter: (v: T) => void) {
    return (v: T) => { setter(v); setCredsDirty(true); };
  }

  async function testConnection() {
    setTesting(true);
    setTestResult(null);
    setMsg(null);
    try {
      // 1) Guardar la fila (cifra el password si se escribió uno nuevo).
      const saveRes = await fetch('/api/casino/account', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_username: agentUsername, agent_id: agentId, skin_id: skinId,
          api_base_url: baseUrl, player_url: playerUrl, player_url_2: playerUrl2,
          credentials_template: template,
          ...(password.trim() ? { agent_password: password.trim() } : {}),
        }),
      });
      if (!saveRes.ok) {
        const e = await saveRes.json().catch(() => null);
        setTestResult({ ok: false, text: e?.error ?? 'No se pudo guardar la conexión.' });
        return;
      }

      // 2) Probar la fila recién guardada (sella connection_verified_at si pasa).
      const testRes = await fetch('/api/casino/test-connection', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ useSaved: true }),
      });
      const t = await testRes.json().catch(() => null);
      if (t?.ok) {
        const balance = Number(t.balance).toLocaleString('es-AR');
        setTestResult({ ok: true, text: `✅ Conectó. Agente ${t.agentName} · ${balance} fichas` });
      } else {
        setTestResult({ ok: false, text: `🔴 ${t?.error ?? 'No se pudo conectar con el casino.'}` });
      }
      await load();   // sincroniza verifiedAt / enabled / has_password
    } catch {
      setTestResult({ ok: false, text: 'Error de red.' });
    } finally {
      setTesting(false);
    }
  }

  async function toggleEnabled() {
    if (togglingEnabled) return;
    const next = !enabled;
    setTogglingEnabled(true);
    setMsg(null);
    try {
      const res = await fetch('/api/casino/account', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok) { setMsg({ kind: 'err', text: j?.error ?? 'No se pudo cambiar el estado.' }); return; }
      setEnabled(!!j.enabled);
    } catch {
      setMsg({ kind: 'err', text: 'Error de red.' });
    } finally {
      setTogglingEnabled(false);
    }
  }

  if (loading) {
    return <p style={{ color: '#999', fontSize: '14px', padding: '8px 0' }}>Cargando configuración…</p>;
  }

  const labelStyle: React.CSSProperties = { display: 'block', fontSize: '12px', fontWeight: 700, color: '#555', marginBottom: '4px' };
  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '10px 12px', boxSizing: 'border-box',
    border: '2px solid #e0e0e0', borderRadius: '10px', fontSize: '14px', fontWeight: 600,
    outline: 'none', background: '#F7F7F7',
  };
  const hintStyle: React.CSSProperties = { margin: '4px 0 0', fontSize: '12px', color: '#888' };
  const sectionTitle: React.CSSProperties = { fontSize: '11px', fontWeight: 800, color: '#999', textTransform: 'uppercase', letterSpacing: '0.5px', margin: '4px 0 -4px' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>

      {/* Badge de estado de verificación */}
      <div style={{
        fontSize: '13px', fontWeight: 800, borderRadius: '10px', padding: '10px 12px',
        background: verified ? '#e8fff0' : '#FFF7E0',
        color: verified ? '#1a7a3a' : '#9a6b00',
      }}>
        {verified
          ? `✅ Verificado${agentUsername ? ` — Agente ${agentUsername}` : ''}`
          : '🟡 Sin verificar · cargá los datos y probá la conexión'}
      </div>

      {/* ── Sección: Conexión ─────────────────────────────────────────── */}
      <div style={sectionTitle}>Conexión</div>

      <div>
        <label style={labelStyle}>Usuario del agente</label>
        <input type="text" value={agentUsername}
          onChange={(e) => onCredChange(setAgentUsername)(e.target.value)}
          placeholder="usuario del panel" style={inputStyle} autoComplete="off" />
      </div>

      <div>
        <label style={labelStyle}>
          Contraseña / token del agente
          <Info text="La clave de ese usuario en el casino. Se guarda cifrada. Dejala vacía para no cambiar la ya guardada." />
        </label>
        <input type="password" value={password}
          onChange={(e) => onCredChange(setPassword)(e.target.value)}
          placeholder={hasPassword ? '•••••••• (guardado — dejar vacío para no cambiar)' : 'Token o contraseña'}
          autoComplete="new-password" style={inputStyle} />
      </div>

      <div>
        <label style={labelStyle}>
          ID de agente
          <Info text="Identificador interno del agente que te da el casino; el sistema lo usa para acreditar las fichas. Si no lo tenés, pedilo a tu proveedor del casino o a soporte." />
        </label>
        <input type="text" value={agentId}
          onChange={(e) => onCredChange(setAgentId)(e.target.value)}
          placeholder="p. ej. cmoj1nya83zdnmhqizvk1hpbt" style={inputStyle} autoComplete="off" />
      </div>

      <div>
        <label style={labelStyle}>
          Skin ID
          <Info text="Identificador del skin/marca del casino; lo exige la creación de usuarios. Te lo da el proveedor del casino." />
        </label>
        <input type="text" value={skinId}
          onChange={(e) => onCredChange(setSkinId)(e.target.value)}
          placeholder="p. ej. eeafa00307a1" style={inputStyle} autoComplete="off" />
      </div>

      <div>
        <label style={labelStyle}>
          Dominio del casino (panel / API)
          <Info text="La dirección del panel de administración del casino, p. ej. https://admin.tucasino.com. Debe estar habilitada por soporte de IRIS; si no, la prueba dará 'casino no habilitado'." />
        </label>
        <input type="text" value={baseUrl}
          onChange={(e) => onCredChange(setBaseUrl)(e.target.value)}
          placeholder="https://admin.tucasino.com" style={inputStyle} />
      </div>

      {/* Probar conexión (guarda + prueba) */}
      <div>
        <button
          onClick={testConnection}
          disabled={testing}
          style={{
            background: '#111', color: '#fff', fontWeight: 800, fontSize: '14px',
            border: 'none', borderRadius: '10px', padding: '11px 22px',
            cursor: testing ? 'wait' : 'pointer', width: '100%',
          }}
        >
          {testing ? 'Probando conexión…' : 'Probar conexión'}
        </button>
        {testResult && (
          <div style={{
            marginTop: '8px', fontSize: '13px', fontWeight: 700, borderRadius: '10px', padding: '10px 12px',
            background: testResult.ok ? '#e8fff0' : '#FFE5E5',
            color: testResult.ok ? '#1a7a3a' : '#CC3333', wordBreak: 'break-word',
          }}>
            {testResult.text}
          </div>
        )}
      </div>

      {/* ── Sección: Mensaje al jugador ───────────────────────────────── */}
      <div style={sectionTitle}>Mensaje al jugador</div>

      <div>
        <label style={labelStyle}>URL para jugadores 1 ({'{link1}'})</label>
        <input type="text" value={playerUrl}
          onChange={(e) => setPlayerUrl(e.target.value)}
          placeholder="https://tucasino.com" style={inputStyle} />
        <p style={hintStyle}>
          La que el jugador recibe en sus credenciales (la pública de juego, distinta de la del panel). Si la dejás vacía, se usa la URL del panel.
        </p>
      </div>

      <div>
        <label style={labelStyle}>URL para jugadores 2 — opcional ({'{link2}'})</label>
        <input type="text" value={playerUrl2}
          onChange={(e) => setPlayerUrl2(e.target.value)}
          placeholder="https://tucasino-alternativo.com" style={inputStyle} />
        <p style={hintStyle}>
          Segundo enlace opcional. Si la dejás vacía, la línea de {'{link2}'} no aparece en el mensaje.
        </p>
      </div>

      <div>
        <label style={labelStyle}>Mensaje de credenciales</label>
        <textarea value={template}
          onChange={(e) => setTemplate(e.target.value)}
          rows={6}
          placeholder={'Usuario: {username}\nContraseña: {password}\n👉 {link1}\n      {link2}\nIngresá y ya podés comenzar 😊'}
          style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.5, fontFamily: 'inherit' }} />
        <p style={hintStyle}>
          Placeholders: {'{username}'}, {'{password}'}, {'{link1}'}, {'{link2}'}. Sin saludo con nombre. Si {'{link2}'} está vacío, esa línea se omite. Dejalo vacío para volver al texto por defecto. Se guarda al probar la conexión.
        </p>
      </div>

      {/* ── Sección: Activación ───────────────────────────────────────── */}
      <div style={sectionTitle}>Activación</div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
        <div>
          <p style={{ margin: 0, fontSize: '14px', fontWeight: 800, color: verified ? '#111' : '#999' }}>Activar depósitos</p>
          <p style={{ margin: '2px 0 0', fontSize: '12px', color: '#888' }}>
            {verified
              ? 'Al verificar una carga, acreditar las fichas al jugador en el casino.'
              : 'Se habilita solo con una conexión verificada.'}
          </p>
        </div>
        <button
          onClick={toggleEnabled}
          role="switch"
          aria-checked={enabled}
          disabled={!verified || togglingEnabled}
          title={!verified ? 'Probá la conexión antes de activar' : undefined}
          style={{
            position: 'relative', width: '52px', height: '30px', flexShrink: 0,
            borderRadius: '999px', border: 'none',
            cursor: !verified ? 'not-allowed' : (togglingEnabled ? 'wait' : 'pointer'),
            opacity: !verified ? 0.5 : 1,
            background: enabled ? '#1a7a3a' : '#ccc', transition: 'background 0.15s',
          }}
        >
          <span style={{
            position: 'absolute', top: '3px', left: enabled ? '25px' : '3px',
            width: '24px', height: '24px', borderRadius: '50%', background: '#fff',
            transition: 'left 0.15s', boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
          }} />
        </button>
      </div>

      {msg && (
        <div style={{
          fontSize: '13px', fontWeight: 600, borderRadius: '10px', padding: '8px 12px',
          background: msg.kind === 'ok' ? '#e8fff0' : '#FFE5E5',
          color: msg.kind === 'ok' ? '#1a7a3a' : '#CC3333',
        }}>
          {msg.text}
        </div>
      )}
    </div>
  );
}
