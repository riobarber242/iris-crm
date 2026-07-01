'use client';

import React, { useEffect, useState } from 'react';

// Configuración del casino (solo rol 'agent'). Switch on/off + URL + token.
// Lee los valores actuales al montar; guarda todo con un solo botón (upsert).
// El password se enmascara: nunca llega del backend; solo se envía si se escribe
// uno nuevo.
export default function CasinoConfigCard() {
  const [enabled, setEnabled]   = useState(false);
  const [baseUrl, setBaseUrl]   = useState('');
  const [playerUrl, setPlayerUrl] = useState('');   // URL pública para el jugador ({link1})
  const [playerUrl2, setPlayerUrl2] = useState(''); // URL pública 2 opcional ({link2})
  const [template, setTemplate] = useState('');     // template del mensaje de credenciales
  const [password, setPassword] = useState('');     // vacío = no se cambia
  const [hasPassword, setHasPassword] = useState(false);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [msg, setMsg]         = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/settings/casino');
        if (!res.ok) { setMsg({ kind: 'err', text: 'No se pudo cargar la configuración.' }); return; }
        const j = await res.json();
        setEnabled(!!j.enabled);
        setBaseUrl(String(j.casino_api_base_url ?? ''));
        setPlayerUrl(String(j.casino_player_url ?? ''));
        setPlayerUrl2(String(j.casino_player_url_2 ?? ''));
        setTemplate(String(j.casino_credentials_template ?? ''));
        setHasPassword(!!j.has_password);
      } catch {
        setMsg({ kind: 'err', text: 'Error de red.' });
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function save() {
    setSaving(true);
    setMsg(null);
    try {
      const payload: Record<string, any> = { enabled, casino_api_base_url: baseUrl, casino_player_url: playerUrl, casino_player_url_2: playerUrl2, casino_credentials_template: template };
      // Solo mandamos el password si el agente escribió uno nuevo.
      if (password.trim()) payload.casino_agent_password = password.trim();

      const res = await fetch('/api/settings/casino', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        setMsg({ kind: 'err', text: t || 'No se pudo guardar.' });
        return;
      }
      const j = await res.json();
      setEnabled(!!j.enabled);
      setBaseUrl(String(j.casino_api_base_url ?? ''));
      setPlayerUrl(String(j.casino_player_url ?? ''));
      setPlayerUrl2(String(j.casino_player_url_2 ?? ''));
      setTemplate(String(j.casino_credentials_template ?? ''));
      setHasPassword(!!j.has_password);
      setPassword('');   // limpiamos el input; queda enmascarado
      setMsg({ kind: 'ok', text: 'Configuración guardada.' });
    } catch {
      setMsg({ kind: 'err', text: 'Error de red.' });
    } finally {
      setSaving(false);
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>

      {/* Switch on/off */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
        <div>
          <p style={{ margin: 0, fontSize: '14px', fontWeight: 800, color: '#111' }}>Integración con el casino</p>
          <p style={{ margin: '2px 0 0', fontSize: '12px', color: '#888' }}>
            Al verificar una carga, acreditar las fichas al jugador en el casino.
          </p>
        </div>
        <button
          onClick={() => setEnabled((v) => !v)}
          role="switch"
          aria-checked={enabled}
          style={{
            position: 'relative', width: '52px', height: '30px', flexShrink: 0,
            borderRadius: '999px', border: 'none', cursor: 'pointer',
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

      {/* Indicador de estado (según switch + URL guardada) */}
      <div style={{
        fontSize: '13px', fontWeight: 700, marginTop: '-6px', wordBreak: 'break-all',
        color: !enabled ? '#777' : (baseUrl.trim() ? '#1a7a3a' : '#9a6b00'),
      }}>
        {!enabled
          ? '⚫ Desactivado'
          : baseUrl.trim()
            ? `🟢 Conectado a: ${baseUrl.trim()}`
            : '🟡 Activado sin URL configurada'}
      </div>

      {/* URL del casino (panel / API admin — la usa el agente, NO el jugador) */}
      <div>
        <label style={labelStyle}>URL del casino (panel / API)</label>
        <input
          type="text" value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://admin.tucasino.com"
          style={inputStyle}
        />
      </div>

      {/* URL para jugadores 1 — {link1} del mensaje de credenciales */}
      <div>
        <label style={labelStyle}>URL para jugadores 1 ({'{link1}'})</label>
        <input
          type="text" value={playerUrl}
          onChange={(e) => setPlayerUrl(e.target.value)}
          placeholder="https://tucasino.com"
          style={inputStyle}
        />
        <p style={{ margin: '4px 0 0', fontSize: '12px', color: '#888' }}>
          La que el jugador recibe en sus credenciales (la pública de juego, distinta de la del panel). Si la dejás vacía, se usa la URL del panel.
        </p>
      </div>

      {/* URL para jugadores 2 — {link2}, opcional */}
      <div>
        <label style={labelStyle}>URL para jugadores 2 — opcional ({'{link2}'})</label>
        <input
          type="text" value={playerUrl2}
          onChange={(e) => setPlayerUrl2(e.target.value)}
          placeholder="https://tucasino-alternativo.com"
          style={inputStyle}
        />
        <p style={{ margin: '4px 0 0', fontSize: '12px', color: '#888' }}>
          Segundo enlace opcional. Si la dejás vacía, la línea de {'{link2}'} no aparece en el mensaje.
        </p>
      </div>

      {/* Template editable del mensaje de credenciales */}
      <div>
        <label style={labelStyle}>Mensaje de credenciales</label>
        <textarea
          value={template}
          onChange={(e) => setTemplate(e.target.value)}
          rows={6}
          placeholder={'Usuario: {username}\nContraseña: {password}\n👉 {link1}\n      {link2}\nIngresá y ya podés comenzar 😊'}
          style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.5, fontFamily: 'inherit' }}
        />
        <p style={{ margin: '4px 0 0', fontSize: '12px', color: '#888' }}>
          Placeholders: {'{username}'}, {'{password}'}, {'{link1}'}, {'{link2}'}. Sin saludo con nombre. Si {'{link2}'} está vacío, esa línea se omite. Dejalo vacío para volver al texto por defecto.
        </p>
      </div>

      {/* Token / credenciales (enmascarado) */}
      <div>
        <label style={labelStyle}>Token / contraseña del agente</label>
        <input
          type="password" value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={hasPassword ? '•••••••• (guardado — dejar vacío para no cambiar)' : 'Token o contraseña'}
          autoComplete="new-password"
          style={inputStyle}
        />
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

      <div>
        <button
          onClick={save} disabled={saving}
          style={{
            background: '#C8FF00', color: '#000', fontWeight: 800, fontSize: '14px',
            border: 'none', borderRadius: '10px', padding: '10px 22px',
            cursor: saving ? 'wait' : 'pointer', boxShadow: '0 2px 0 #8ab000',
          }}
        >
          {saving ? 'Guardando…' : 'Guardar'}
        </button>
      </div>
    </div>
  );
}
