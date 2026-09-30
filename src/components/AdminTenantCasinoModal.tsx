'use client';

import React, { useEffect, useMemo, useState } from 'react';

// Configuración de casino de un tenant, para el admin global (Admin → Tenants →
// 🎰 Casino). Genérico: el formulario se arma con los campos que declara cada
// proveedor del registro (lib/casino/providers), así que sumar un casino no toca
// esta pantalla. API: /api/tenants/[id]/casino (+ /tools para las pruebas).
//
// Secretos: los inputs de tipo secreto arrancan SIEMPRE vacíos; el backend solo dice
// si hay uno cargado. Vacío al guardar = no se cambia el guardado.
// "Probar y guardar": si cambia la conexión, el backend prueba con los datos nuevos y
// solo guarda si la prueba pasa (una prueba fallida no pisa la conexión que andaba).

interface ProviderField {
  key: string; label: string; kind: 'text' | 'url' | 'secret'; required: boolean;
  help: string | null; placeholder: string | null; defaultValue: string | null;
}
interface ProviderInfo { id: string; label: string; hasAgentBalance: boolean; testTools: boolean; fields: ProviderField[] }
interface CasinoState {
  providers: ProviderInfo[];
  enabled: boolean;
  default_template: string;
  account: {
    has_row: boolean; provider: string | null; values: Record<string, string>; has_secrets: Record<string, boolean>;
    label: string | null; active: boolean; connection_verified_at: string | null;
    player_url: string; player_url_2: string; credentials_template: string;
  };
}

const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(10,11,6,0.5)', zIndex: 990,
  display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '40px 16px', overflowY: 'auto',
};
const panel: React.CSSProperties = {
  background: '#fff', borderRadius: '20px', padding: '22px', width: '100%', maxWidth: '620px',
  display: 'flex', flexDirection: 'column', gap: '14px', boxShadow: '0 12px 48px rgba(0,0,0,0.25)',
};
const inputStyle: React.CSSProperties = {
  background: '#F5F5F5', border: '1px solid #eee', borderRadius: '9px',
  padding: '9px 11px', fontSize: '13.5px', color: '#000', outline: 'none', width: '100%', boxSizing: 'border-box',
};
const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: '10.5px', fontWeight: 800, color: '#999', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '4px',
};
const hint: React.CSSProperties = { margin: '4px 0 0', fontSize: '11.5px', color: '#999' };
const sectionTitle: React.CSSProperties = { fontSize: '12px', fontWeight: 900, color: '#333', margin: '6px 0 -2px' };
const btn = (bg: string, fg: string): React.CSSProperties => ({
  border: 'none', borderRadius: '10px', padding: '9px 14px', fontSize: '12.5px', fontWeight: 800, cursor: 'pointer', background: bg, color: fg,
});

type Msg = { kind: 'ok' | 'err'; text: string } | null;

function Box({ msg }: { msg: Msg }) {
  if (!msg) return null;
  return (
    <div style={{
      fontSize: '12.5px', fontWeight: 700, borderRadius: '10px', padding: '9px 12px', wordBreak: 'break-word',
      background: msg.kind === 'ok' ? '#e8fff0' : '#FFE5E5', color: msg.kind === 'ok' ? '#1a7a3a' : '#CC3333',
    }}>{msg.text}</div>
  );
}

export default function AdminTenantCasinoModal({ tenant, onClose }: {
  tenant: { id: string; name: string };
  onClose: () => void;
}) {
  const base = `/api/tenants/${tenant.id}/casino`;
  const [st, setSt] = useState<CasinoState | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<Msg>(null);

  // Formulario
  const [providerId, setProviderId] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [playerUrl, setPlayerUrl] = useState('');
  const [playerUrl2, setPlayerUrl2] = useState('');
  const [template, setTemplate] = useState('');
  const [needsConfirm, setNeedsConfirm] = useState<string | null>(null);

  // Herramientas de prueba
  const [tUser, setTUser] = useState('');
  const [tPass, setTPass] = useState('');
  const [tAmount, setTAmount] = useState('1');
  const [confirmDeposit, setConfirmDeposit] = useState(false);
  const [toolMsg, setToolMsg] = useState<Msg>(null);

  function hydrate(s: CasinoState) {
    setSt(s);
    const pid = s.account.provider ?? '';
    setProviderId(pid);
    setValues({ ...s.account.values });       // secretos nunca vienen: arrancan vacíos
    setPlayerUrl(s.account.player_url ?? '');
    setPlayerUrl2(s.account.player_url_2 ?? '');
    setTemplate(s.account.credentials_template ?? '');
    setNeedsConfirm(null);
  }

  async function load() {
    try {
      const res = await fetch(base, { cache: 'no-store' });
      if (!res.ok) { setLoadErr(await res.text().catch(() => 'No se pudo cargar')); return; }
      hydrate(await res.json());
    } catch { setLoadErr('Error de red'); }
  }
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const provider = useMemo(() => st?.providers.find((p) => p.id === providerId) ?? null, [st, providerId]);
  const savedProvider = useMemo(() => st?.providers.find((p) => p.id === st?.account.provider) ?? null, [st]);
  const sameAsSaved = !!st?.account.has_row && st.account.provider === providerId;
  const verified = !!st?.account.connection_verified_at;

  function onProviderChange(id: string) {
    setProviderId(id);
    setMsg(null);
    setNeedsConfirm(null);
    // Al volver al proveedor guardado se recuperan sus valores; si no, formulario limpio.
    setValues(st && st.account.provider === id ? { ...st.account.values } : {});
  }

  async function post(body: Record<string, unknown>) {
    const res = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await res.json().catch(() => ({}));
    return { res, j };
  }

  async function save(confirmProviderChange = false) {
    if (!provider) return;
    setBusy('save'); setMsg(null);
    try {
      const { res, j } = await post({
        action: 'save', provider: provider.id, values,
        player_url: playerUrl, player_url_2: playerUrl2, credentials_template: template,
        confirm_provider_change: confirmProviderChange,
      });
      if (res.status === 409 && j.needs_confirmation) { setNeedsConfirm(j.error); return; }
      if (!res.ok) { setMsg({ kind: 'err', text: j.error ?? 'No se pudo guardar' }); return; }
      hydrate(j);
      setMsg({ kind: 'ok', text: j.tested ? '✅ Conexión probada y guardada. El casino quedó desactivado: activalo cuando quieras.' : '✅ Guardado.' });
    } catch { setMsg({ kind: 'err', text: 'Error de red' }); }
    finally { setBusy(null); }
  }

  async function testSaved() {
    setBusy('test'); setMsg(null);
    try {
      const { j } = await post({ action: 'test' });
      if (j.ok) { hydrate(j); setMsg({ kind: 'ok', text: `✅ ${j.message}` }); }
      else setMsg({ kind: 'err', text: `🔴 ${j.error ?? 'Falló la prueba'}` });
    } catch { setMsg({ kind: 'err', text: 'Error de red' }); }
    finally { setBusy(null); }
  }

  async function toggleEnabled() {
    if (!st) return;
    setBusy('enabled'); setMsg(null);
    try {
      const { res, j } = await post({ action: 'set_enabled', enabled: !st.enabled });
      if (!res.ok) { setMsg({ kind: 'err', text: j.error ?? 'No se pudo cambiar' }); return; }
      hydrate(j);
      setMsg({ kind: 'ok', text: j.enabled ? '✅ Casino activado.' : 'Casino desactivado.' });
    } catch { setMsg({ kind: 'err', text: 'Error de red' }); }
    finally { setBusy(null); }
  }

  async function tool(action: 'player_balance' | 'create_player' | 'deposit') {
    setBusy(action); setToolMsg(null);
    try {
      const res = await fetch(`${base}/tools`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, username: tUser, password: tPass || undefined, amount: Number(tAmount) }),
      });
      const j = await res.json().catch(() => ({}));
      if (action === 'player_balance') {
        setToolMsg(j.ok ? { kind: 'ok', text: `Saldo de ${tUser}: ${Number(j.balance).toLocaleString('es-AR')}` } : { kind: 'err', text: j.error ?? 'Error' });
      } else if (action === 'create_player') {
        setToolMsg(j.ok
          ? { kind: 'ok', text: `✅ Jugador creado: ${j.username} · contraseña ${j.password}` }
          : { kind: 'err', text: `${j.error ?? 'Error'}${j.ambiguous ? ' (no se sabe si se creó: consultá el saldo antes de reintentar)' : ''}` });
      } else {
        const antes = j.balance_before != null ? Number(j.balance_before).toLocaleString('es-AR') : '—';
        const despues = j.balance_after != null ? Number(j.balance_after).toLocaleString('es-AR') : '—';
        setToolMsg(j.ok
          ? { kind: 'ok', text: `✅ Depósito OK. Saldo antes ${antes} → después ${despues}. Queda como "operación API" en el panel del casino.` }
          : { kind: 'err', text: `${j.error ?? 'Error'}${j.balance_before != null ? ` (saldo antes ${antes}${j.balance_after != null ? `, después ${despues}` : ''})` : ''}` });
      }
    } catch { setToolMsg({ kind: 'err', text: 'Error de red' }); }
    finally { setBusy(null); setConfirmDeposit(false); }
  }

  return (
    <div style={overlay} onClick={onClose}>
      <div style={panel} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '10px' }}>
          <div style={{ minWidth: 0 }}>
            <h2 style={{ fontSize: '19px', fontWeight: 900, color: '#000', margin: 0 }}>🎰 Casino · {tenant.name}</h2>
            <p style={{ fontSize: '12.5px', color: '#999', margin: '3px 0 0' }}>Proveedor, conexión y activación del casino de este cliente</p>
          </div>
          <button onClick={onClose} aria-label="Cerrar" style={{ border: 'none', background: '#F0F0F0', color: '#666', borderRadius: '9px', width: 32, height: 32, fontSize: 16, cursor: 'pointer', flexShrink: 0 }}>✕</button>
        </div>

        {loadErr && <Box msg={{ kind: 'err', text: loadErr }} />}
        {!st && !loadErr && <p style={{ color: '#999', fontSize: '13px' }}>Cargando…</p>}

        {st && (
          <>
            {/* Estado */}
            <div style={{
              fontSize: '13px', fontWeight: 800, borderRadius: '10px', padding: '10px 12px',
              background: !st.account.has_row ? '#f5f5f5' : st.enabled ? '#e8fff0' : verified ? '#FFF7E0' : '#FFF0F0',
              color: !st.account.has_row ? '#777' : st.enabled ? '#1a7a3a' : verified ? '#9a6b00' : '#CC3333',
            }}>
              {!st.account.has_row
                ? 'Sin casino configurado'
                : `${st.enabled ? '✅ Activado' : '○ Desactivado'} · ${savedProvider?.label ?? st.account.provider} · ${verified
                    ? `conexión verificada ${new Date(st.account.connection_verified_at!).toLocaleString('es-AR')}`
                    : 'conexión sin verificar'}`}
            </div>

            {/* Proveedor */}
            <div>
              <label style={labelStyle}>Proveedor</label>
              <select value={providerId} onChange={(e) => onProviderChange(e.target.value)} style={inputStyle}>
                <option value="">— Elegí un proveedor —</option>
                {st.providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
              {st.account.has_row && !sameAsSaved && providerId && (
                <p style={{ ...hint, color: '#C0392B', fontWeight: 700 }}>
                  Cambiar de proveedor borra la conexión anterior y apaga el casino.
                </p>
              )}
            </div>

            {provider && (
              <>
                <div style={sectionTitle}>Conexión</div>
                {provider.fields.map((f) => {
                  const loaded = sameAsSaved && !!st.account.has_secrets[f.key];
                  return (
                    <div key={f.key}>
                      <label style={labelStyle}>{f.label}{f.required ? '' : ' (opcional)'}</label>
                      <input
                        type={f.kind === 'secret' ? 'password' : 'text'}
                        value={values[f.key] ?? ''}
                        onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                        placeholder={f.kind === 'secret'
                          ? (loaded ? '•••••••• cargada ✓ — vacío = no se cambia' : 'Pegala acá')
                          : (f.placeholder ?? '')}
                        autoComplete={f.kind === 'secret' ? 'new-password' : 'off'}
                        style={inputStyle}
                      />
                      {f.help && <p style={hint}>{f.help}</p>}
                    </div>
                  );
                })}

                <div style={sectionTitle}>Mensaje al jugador</div>
                <div>
                  <label style={labelStyle}>URL para jugadores 1 ({'{link1}'})</label>
                  <input value={playerUrl} onChange={(e) => setPlayerUrl(e.target.value)} style={inputStyle} placeholder="https://tucasino.com" />
                </div>
                <div>
                  <label style={labelStyle}>URL para jugadores 2 ({'{link2}'}, opcional)</label>
                  <input value={playerUrl2} onChange={(e) => setPlayerUrl2(e.target.value)} style={inputStyle} />
                </div>
                <div>
                  <label style={labelStyle}>Mensaje de credenciales</label>
                  <textarea value={template} onChange={(e) => setTemplate(e.target.value)} rows={5}
                    placeholder={st.default_template} style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }} />
                  <p style={hint}>Placeholders: {'{username}'}, {'{password}'}, {'{link1}'}, {'{link2}'}. Vacío = texto por defecto.</p>
                </div>

                {needsConfirm ? (
                  <div style={{ background: '#FFF0F0', borderRadius: '10px', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <span style={{ fontSize: '12.5px', fontWeight: 700, color: '#C0392B' }}>{needsConfirm}</span>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <button disabled={!!busy} onClick={() => save(true)} style={btn('#C0392B', '#fff')}>Sí, cambiar de proveedor</button>
                      <button disabled={!!busy} onClick={() => setNeedsConfirm(null)} style={btn('#F0F0F0', '#333')}>Cancelar</button>
                    </div>
                  </div>
                ) : (
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    <button disabled={!!busy} onClick={() => save(false)} style={{ ...btn('#111', '#fff'), opacity: busy ? 0.6 : 1 }}>
                      {busy === 'save' ? 'Probando y guardando…' : 'Probar y guardar'}
                    </button>
                    {sameAsSaved && (
                      <button disabled={!!busy} onClick={testSaved} style={{ ...btn('#F0F0F0', '#333'), opacity: busy ? 0.6 : 1 }}>
                        {busy === 'test' ? 'Probando…' : 'Probar conexión guardada'}
                      </button>
                    )}
                  </div>
                )}
              </>
            )}

            <Box msg={msg} />

            {/* Activación */}
            {st.account.has_row && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', borderTop: '1px solid #eee', paddingTop: '12px' }}>
                <div>
                  <p style={{ margin: 0, fontSize: '14px', fontWeight: 800, color: verified ? '#111' : '#999' }}>Casino activado</p>
                  <p style={{ margin: '2px 0 0', fontSize: '12px', color: '#888' }}>
                    {verified ? 'Con el casino activado, verificar una carga acredita las fichas al jugador.' : 'Se habilita con una conexión verificada.'}
                  </p>
                </div>
                <button
                  role="switch" aria-checked={st.enabled} onClick={toggleEnabled}
                  disabled={(!verified && !st.enabled) || !!busy}
                  style={{
                    position: 'relative', width: '52px', height: '30px', flexShrink: 0, borderRadius: '999px', border: 'none',
                    cursor: (!verified && !st.enabled) ? 'not-allowed' : 'pointer', opacity: (!verified && !st.enabled) ? 0.5 : 1,
                    background: st.enabled ? '#1a7a3a' : '#ccc',
                  }}
                >
                  <span style={{ position: 'absolute', top: '3px', left: st.enabled ? '25px' : '3px', width: '24px', height: '24px', borderRadius: '50%', background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,0.3)' }} />
                </button>
              </div>
            )}

            {/* Herramientas de prueba (proveedores del modelo nuevo, con conexión guardada) */}
            {savedProvider?.testTools && verified && (
              <div style={{ borderTop: '1px solid #eee', paddingTop: '12px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <div style={sectionTitle}>Herramientas de prueba</div>
                <p style={{ ...hint, margin: 0 }}>
                  Operan directo contra {savedProvider.label}, aunque el casino esté desactivado. No tocan contactos ni comprobantes.
                </p>
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  <input value={tUser} onChange={(e) => setTUser(e.target.value)} placeholder="usuario del jugador" style={{ ...inputStyle, flex: '1 1 160px', width: 'auto' }} />
                  <input value={tPass} onChange={(e) => setTPass(e.target.value)} placeholder="contraseña (alta; vacía = automática)" style={{ ...inputStyle, flex: '1 1 160px', width: 'auto' }} />
                </div>
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
                  <button disabled={!!busy || !tUser.trim()} onClick={() => tool('player_balance')} style={btn('#F0F0F0', '#333')}>
                    {busy === 'player_balance' ? '…' : 'Consultar saldo'}
                  </button>
                  <button disabled={!!busy || !tUser.trim()} onClick={() => tool('create_player')} style={btn('#F0F0F0', '#333')}>
                    {busy === 'create_player' ? '…' : 'Crear jugador de prueba'}
                  </button>
                  <input value={tAmount} onChange={(e) => setTAmount(e.target.value)} inputMode="decimal" style={{ ...inputStyle, width: '80px' }} aria-label="Monto" />
                  {confirmDeposit ? (
                    <>
                      <button disabled={!!busy} onClick={() => tool('deposit')} style={btn('#C0392B', '#fff')}>
                        {busy === 'deposit' ? 'Depositando…' : `Confirmar depósito de ${tAmount} a ${tUser}`}
                      </button>
                      <button disabled={!!busy} onClick={() => setConfirmDeposit(false)} style={btn('#F0F0F0', '#333')}>Cancelar</button>
                    </>
                  ) : (
                    <button disabled={!!busy || !tUser.trim()} onClick={() => setConfirmDeposit(true)} style={btn('#111', '#fff')}>
                      Depósito de prueba (máx. 100)
                    </button>
                  )}
                </div>
                <Box msg={toolMsg} />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
