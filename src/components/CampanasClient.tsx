"use client";

import React, { useEffect, useState } from 'react';

type CampaignType = 'texto_libre' | 'template_meta';

type Campaign = {
  id: string;
  name: string;
  message: string | null;
  type: CampaignType;
  template_name: string | null;
  template_language: string | null;
  template_variables: string[] | null;
  target_filter: string;
  target_number_id: string | null;
  status: 'borrador' | 'enviando' | 'completada';
  sent_count: number;
  created_at: string;
  recipient_ids: string[] | null;
};

type WaLine = { id: string; label: string | null; active: boolean; is_default: boolean };

const STATUS_STYLE: Record<string, React.CSSProperties> = {
  borrador:   { background: '#F0F0F0', color: '#888' },
  enviando:   { background: '#fff8d6', color: '#b8860b', border: '1px solid #f0c040' },
  completada: { background: '#e8fff0', color: '#1a7a3a', border: '1px solid #5ad87a' },
};

const FILTERS = [
  { value: 'todos',          label: 'Todos los contactos' },
  { value: 'cliente_activo', label: 'Cliente activo' },
  { value: 'inactivo',       label: 'Inactivo' },
  { value: 'inactivo_30d',   label: 'Inactivo sin recargar 30+ días' },
  { value: 'inactivo_45d',   label: 'Inactivo sin recargar 45+ días' },
  { value: 'nuevo',          label: 'Nuevo' },
];

// Rangos del historial de envíos
const HISTORY_RANGES = [
  { value: '7d',  label: '7 días',  days: 7 },
  { value: '15d', label: '15 días', days: 15 },
  { value: '1m',  label: '1 mes',   days: 30 },
  { value: '3m',  label: '3 meses', days: 90 },
  { value: '1y',  label: '1 año',   days: 365 },
];

const inputStyle: React.CSSProperties = {
  background: '#F5F5F5', border: 'none', borderRadius: '10px',
  padding: '10px 14px', fontSize: '14px', color: '#000', outline: 'none', width: '100%',
  boxSizing: 'border-box',
};

const labelStyle: React.CSSProperties = {
  fontSize: '11px', fontWeight: 700, color: '#999',
  textTransform: 'uppercase', letterSpacing: '0.08em',
};

export default function CampanasClient() {
  const [campaigns,      setCampaigns]      = useState<Campaign[]>([]);
  const [showForm,       setShowForm]       = useState(false);
  const [sending,        setSending]        = useState<string | null>(null);
  const [sendResult,     setSendResult]     = useState<{ campaignId: string; sent: number; total: number } | null>(null);
  const [recipientCount, setRecipientCount] = useState<number | null>(null);
  const [countLoading,   setCountLoading]   = useState(false);
  const [creating,       setCreating]       = useState(false);
  const [error,          setError]          = useState('');
  // Abierto por defecto: colapsado pasaba desapercibido y parecía que no existía.
  const [historyOpen,    setHistoryOpen]    = useState(true);
  const [historyRange,   setHistoryRange]   = useState('1m');

  // Lista principal: solo campañas activas. Las completadas viven en el historial.
  const activeCampaigns = campaigns.filter((c) => c.status !== 'completada');

  // Líneas de WhatsApp del tenant (para el filtro por línea)
  const [lines, setLines] = useState<WaLine[]>([]);

  // Form state
  const [name,             setName]             = useState('');
  const [campaignType,     setCampaignType]     = useState<CampaignType>('texto_libre');
  const [filter,           setFilter]           = useState('todos');
  const [lineFilter,       setLineFilter]       = useState('todas');
  const [sendLimit,        setSendLimit]        = useState('');
  const [message,          setMessage]          = useState('');
  const [templateName,     setTemplateName]     = useState('');
  const [templateLang,     setTemplateLang]     = useState('es');
  const [templateVars,     setTemplateVars]     = useState<string[]>(['']);

  async function fetchCampaigns() {
    try {
      const res = await fetch('/api/campaigns');
      if (!res.ok) return;
      setCampaigns(await res.json());
    } catch {}
  }

  useEffect(() => {
    fetchCampaigns();
    // Líneas del tenant para el selector (si falla, el filtro simplemente no aparece).
    fetch('/api/whatsapp-numbers')
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setLines(Array.isArray(d) ? d : []))
      .catch(() => {});
    const t = setInterval(fetchCampaigns, 10_000);
    return () => clearInterval(t);
  }, []);

  async function fetchRecipientCount(f: string, line: string) {
    setCountLoading(true);
    setRecipientCount(null);
    try {
      const isInactivoDays = f === 'inactivo_30d' || f === 'inactivo_45d';
      const param = isInactivoDays
        ? `?status=inactivo`
        : f === 'todos' ? '?all=true' : `?status=${f}`;
      const lineParam = line !== 'todas' ? `&number=${line}` : '';
      const res = await fetch(`/api/contacts${param}${lineParam}`);
      if (!res.ok) return;
      const data = await res.json();
      setRecipientCount(Array.isArray(data) ? data.length : null);
    } catch {}
    setCountLoading(false);
  }

  function handleFilterChange(f: string) {
    setFilter(f);
    fetchRecipientCount(f, lineFilter);
  }

  function handleLineChange(l: string) {
    setLineFilter(l);
    fetchRecipientCount(filter, l);
  }

  function resetForm() {
    setName(''); setCampaignType('texto_libre'); setFilter('todos'); setLineFilter('todas'); setSendLimit('');
    setMessage(''); setTemplateName(''); setTemplateLang('es'); setTemplateVars(['']);
    setError(''); setRecipientCount(null);
  }

  function prefillReactivacion() {
    setCampaignType('template_meta');
    setName('Reactivación — Bono 20%');
    setFilter('inactivo_30d');
    setTemplateLang('es');
    setTemplateName('');
    setTemplateVars(['20%']);
    fetchRecipientCount('inactivo_30d', lineFilter);
  }

  async function handleDelete(campaign: Campaign) {
    if (!confirm(`¿Eliminar la campaña "${campaign.name}"?`)) return;
    try {
      await fetch('/api/campaigns', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ campaignId: campaign.id }),
      });
      await fetchCampaigns();
    } catch {}
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setError('Completá el nombre.'); return; }
    if (campaignType === 'texto_libre' && !message.trim()) { setError('Completá el mensaje.'); return; }
    if (campaignType === 'template_meta' && !templateName.trim()) { setError('Completá el nombre del template.'); return; }

    setCreating(true); setError('');
    try {
      const body: any = {
        name: name.trim(), target_filter: filter, type: campaignType,
        send_limit: sendLimit ? Number(sendLimit) : null,
        target_number_id: lineFilter !== 'todas' ? lineFilter : null,
      };
      if (campaignType === 'texto_libre') {
        body.message = message.trim();
      } else {
        body.template_name      = templateName.trim();
        body.template_language  = templateLang.trim() || 'es';
        body.template_variables = templateVars.filter(Boolean);
      }
      const res = await fetch('/api/campaigns', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await res.text());
      resetForm(); setShowForm(false); await fetchCampaigns();
    } catch (err: any) {
      setError(err.message ?? 'Error al crear la campaña.');
    }
    setCreating(false);
  }

  async function handleSend(campaign: Campaign) {
    const desc = campaign.type === 'template_meta'
      ? `template "${campaign.template_name}"`
      : 'este mensaje';
    if (!confirm(`¿Enviar ${desc} a los contactos con filtro "${campaign.target_filter}"? Esta acción no se puede deshacer.`)) return;
    setSending(campaign.id); setSendResult(null);
    try {
      const res = await fetch('/api/campaigns/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ campaignId: campaign.id }),
      });
      const data = await res.json();
      if (res.ok) setSendResult({ campaignId: campaign.id, sent: data.sent, total: data.total });
      else alert(`Error: ${data?.error ?? res.statusText}`);
    } catch { alert('Error de red al enviar la campaña.'); }
    setSending(null); await fetchCampaigns();
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontSize: '22px', fontWeight: 900, color: '#000', margin: 0 }}>Campañas</h1>
          <p style={{ fontSize: '13px', color: '#999', margin: '4px 0 0 0' }}>Mensajes masivos segmentados por tipo de contacto.</p>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          {!showForm && (
            <button
              onClick={() => { prefillReactivacion(); setShowForm(true); }}
              style={{ background: '#f0fff4', color: '#1a7a3a', fontWeight: 700, fontSize: '13px', border: '1px solid #86efac', borderRadius: '12px', padding: '10px 16px', cursor: 'pointer' }}
            >
              ♻️ Reactivación
            </button>
          )}
          <button
            onClick={() => { if (showForm) { resetForm(); setShowForm(false); } else { setShowForm(true); fetchRecipientCount('todos', lineFilter); } }}
            style={{ background: '#1a1a1a', color: '#C8FF00', fontWeight: 800, fontSize: '13px', border: 'none', borderRadius: '12px', padding: '10px 20px', cursor: 'pointer' }}
          >
            {showForm ? '✕ Cancelar' : '+ Nueva campaña'}
          </button>
        </div>
      </div>

      {/* Formulario */}
      {showForm && (
        <form onSubmit={handleCreate} style={{ background: '#fff', borderRadius: '16px', padding: '20px 24px', boxShadow: '0 2px 12px rgba(0,0,0,0.08)', display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <p style={{ fontSize: '15px', fontWeight: 800, color: '#000', margin: 0 }}>Nueva campaña</p>

          {/* Nombre */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label style={labelStyle}>Nombre</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej: Promo junio 2026" style={inputStyle} />
          </div>

          {/* Tipo */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label style={labelStyle}>Tipo de mensaje</label>
            <div style={{ display: 'flex', gap: '8px' }}>
              {(['texto_libre', 'template_meta'] as CampaignType[]).map((t) => (
                <button
                  key={t} type="button"
                  onClick={() => setCampaignType(t)}
                  style={{
                    flex: 1, padding: '10px 14px', borderRadius: '10px', fontWeight: 700, fontSize: '13px', cursor: 'pointer',
                    border: campaignType === t ? '2px solid #C8FF00' : '2px solid #e0e0e0',
                    background: campaignType === t ? '#f9ffe0' : '#F5F5F5',
                    color: campaignType === t ? '#000' : '#888',
                  }}
                >
                  {t === 'texto_libre' ? '✏️ Texto libre' : '📋 Template Meta'}
                </button>
              ))}
            </div>
            {campaignType === 'texto_libre' && (
              <p style={{ fontSize: '11px', color: '#bbb', margin: 0 }}>Solo funciona si el contacto te escribió en las últimas 24 hs.</p>
            )}
            {campaignType === 'template_meta' && (
              <p style={{ fontSize: '11px', color: '#1a7a3a', margin: 0, fontWeight: 600 }}>Puede llegar a cualquier contacto. Requiere un template aprobado por Meta.</p>
            )}
          </div>

          {/* Destinatarios */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label style={labelStyle}>Destinatarios</label>
            <select value={filter} onChange={(e) => handleFilterChange(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
              {FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
            {lines.length > 0 && (
              <>
                <label style={{ ...labelStyle, marginTop: '4px' }}>Línea</label>
                <select value={lineFilter} onChange={(e) => handleLineChange(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
                  <option value="todas">Todas las líneas</option>
                  {lines.map((l) => (
                    <option key={l.id} value={l.id}>
                      {(l.label ?? l.id)}{l.is_default ? ' (default)' : ''}{!l.active ? ' — inactiva' : ''}
                    </option>
                  ))}
                </select>
              </>
            )}
            {(countLoading || recipientCount !== null) && (
              <p style={{ fontSize: '12px', color: '#555', margin: 0, fontWeight: 600 }}>
                {countLoading ? 'Contando...' : `~${recipientCount} contacto${recipientCount !== 1 ? 's' : ''}`}
                {(filter === 'inactivo_30d' || filter === 'inactivo_45d') && !countLoading && (
                  <span style={{ color: '#888', fontWeight: 400 }}> (estimado — el filtro exacto aplica al enviar)</span>
                )}
              </p>
            )}
          </div>

          {/* Límite de contactos */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label style={labelStyle}>Límite de contactos (opcional)</label>
            <input
              type="number" min={1} value={sendLimit}
              onChange={(e) => setSendLimit(e.target.value)}
              placeholder="Sin límite"
              style={inputStyle}
            />
          </div>

          {/* Contenido según tipo */}
          {campaignType === 'texto_libre' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label style={labelStyle}>Mensaje</label>
              <textarea
                value={message} onChange={(e) => setMessage(e.target.value)}
                placeholder="Escribí el mensaje que van a recibir..." rows={4}
                style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }}
              />
              <p style={{ fontSize: '11px', color: '#bbb', margin: 0 }}>{message.length} caracteres</p>
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', gap: '10px' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', flex: 2 }}>
                  <label style={labelStyle}>Nombre del template</label>
                  <input value={templateName} onChange={(e) => setTemplateName(e.target.value)} placeholder="Ej: reactivacion_bono" style={inputStyle} />
                  <p style={{ fontSize: '11px', color: '#bbb', margin: 0 }}>Debe coincidir exactamente con el nombre en Meta Business Manager.</p>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', flex: 1 }}>
                  <label style={labelStyle}>Idioma</label>
                  <input value={templateLang} onChange={(e) => setTemplateLang(e.target.value)} placeholder="es" style={inputStyle} />
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <label style={labelStyle}>Variables del template <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(una por línea en el template)</span></label>
                <p style={{ fontSize: '11px', color: '#1a7a3a', margin: 0, fontWeight: 600 }}>
                  Usá <code>{'{{nombre}}'}</code> para que cada contacto reciba su propio nombre (o su teléfono si no tiene).
                </p>
                {templateVars.map((v, i) => (
                  <div key={i} style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                    <span style={{ fontSize: '12px', color: '#aaa', minWidth: '28px' }}>{`{{${i + 1}}}`}</span>
                    <input
                      value={v}
                      onChange={(e) => { const next = [...templateVars]; next[i] = e.target.value; setTemplateVars(next); }}
                      placeholder={`Valor de {{${i + 1}}}`}
                      style={{ ...inputStyle, flex: 1 }}
                    />
                    <button
                      type="button"
                      onClick={() => { const next = [...templateVars]; next[i] = '{{nombre}}'; setTemplateVars(next); }}
                      title="Insertar el nombre del contacto"
                      style={{ background: '#f0fff4', border: '1px solid #86efac', borderRadius: '8px', padding: '8px 10px', fontSize: '11px', color: '#1a7a3a', fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0 }}
                    >
                      + {'{{nombre}}'}
                    </button>
                    {templateVars.length > 1 && (
                      <button type="button" onClick={() => setTemplateVars(templateVars.filter((_, j) => j !== i))} style={{ background: 'none', border: 'none', color: '#ccc', fontSize: '18px', cursor: 'pointer', padding: '0 4px' }}>×</button>
                    )}
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => setTemplateVars([...templateVars, ''])}
                  style={{ background: 'none', border: '1px dashed #ccc', borderRadius: '8px', padding: '6px 12px', fontSize: '12px', color: '#888', cursor: 'pointer', alignSelf: 'flex-start' }}
                >
                  + Agregar variable
                </button>
              </div>
            </>
          )}

          {error && <p style={{ fontSize: '13px', color: '#E53935', fontWeight: 600, margin: 0 }}>{error}</p>}

          <button type="submit" disabled={creating} style={{ background: creating ? '#e0e0e0' : '#C8FF00', color: '#000', fontWeight: 800, fontSize: '14px', border: 'none', borderRadius: '12px', padding: '12px 20px', cursor: creating ? 'not-allowed' : 'pointer', opacity: creating ? 0.6 : 1, alignSelf: 'flex-start' }}>
            {creating ? 'Guardando...' : 'Guardar campaña'}
          </button>
        </form>
      )}

      {/* Aviso WhatsApp */}
      <div style={{ background: '#fffbe6', border: '1px solid #f0c040', borderRadius: '12px', padding: '12px 16px', display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
        <span style={{ fontSize: '16px', flexShrink: 0 }}>⚠️</span>
        <p style={{ fontSize: '13px', color: '#7a5c00', margin: 0, lineHeight: 1.6 }}>
          <strong>Límite de WhatsApp:</strong> Los mensajes de texto libre solo llegan a contactos activos en las últimas 24 hs.
          Para reactivación usá <strong>Template Meta</strong> — creá el template en Meta Business Manager y esperá aprobación antes de enviar.
        </p>
      </div>

      {/* Lista de campañas activas (las completadas están en el historial) */}
      {activeCampaigns.length === 0 && !showForm && (
        <div style={{ textAlign: 'center', padding: '48px 0', color: '#999', fontSize: '14px' }}>No hay campañas activas. Creá una con el botón de arriba.</div>
      )}

      {activeCampaigns.map((campaign) => {
        const estilo    = STATUS_STYLE[campaign.status] ?? STATUS_STYLE.borrador;
        const isSending = sending === campaign.id;
        const result    = sendResult?.campaignId === campaign.id ? sendResult : null;
        const isTemplate = campaign.type === 'template_meta';

        return (
          <div key={campaign.id} style={{ background: '#fff', borderRadius: '16px', padding: '18px 22px', boxShadow: '0 2px 10px rgba(0,0,0,0.07)', display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <p style={{ fontSize: '16px', fontWeight: 800, color: '#000', margin: 0 }}>{campaign.name}</p>
                  <span style={{ fontSize: '11px', background: isTemplate ? '#f0fff4' : '#F5F5F5', color: isTemplate ? '#1a7a3a' : '#888', border: isTemplate ? '1px solid #86efac' : '1px solid #e0e0e0', borderRadius: '6px', padding: '2px 8px', fontWeight: 700 }}>
                    {isTemplate ? '📋 Template' : '✏️ Texto'}
                  </span>
                </div>
                <p style={{ fontSize: '12px', color: '#aaa', margin: '3px 0 0 0' }}>
                  Filtro: <strong>{FILTERS.find(f => f.value === campaign.target_filter)?.label ?? campaign.target_filter}</strong>
                  {campaign.target_number_id && (
                    <> · Línea: <strong>{lines.find((l) => l.id === campaign.target_number_id)?.label ?? campaign.target_number_id}</strong></>
                  )}
                  {' · '}{new Date(campaign.created_at).toLocaleDateString('es-AR')}
                  {campaign.sent_count > 0 && ` · ${campaign.sent_count} enviados`}
                </p>
              </div>
              <span style={{ ...estilo, fontSize: '11px', fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase', padding: '4px 12px', borderRadius: '20px', whiteSpace: 'nowrap' }}>
                {campaign.status}
              </span>
            </div>

            {isTemplate ? (
              <div style={{ background: '#F8F8F8', borderRadius: '10px', padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <p style={{ margin: 0, fontSize: '12px', color: '#888' }}>Template: <strong style={{ color: '#333' }}>{campaign.template_name}</strong> · lang: {campaign.template_language}</p>
                {campaign.template_variables && campaign.template_variables.length > 0 && (
                  <p style={{ margin: 0, fontSize: '12px', color: '#888' }}>
                    Variables: {campaign.template_variables.map((v, i) => <span key={i} style={{ marginRight: '8px' }}><code>{`{{${i + 1}}}`}</code> = <strong>{v}</strong></span>)}
                  </p>
                )}
              </div>
            ) : (
              <p style={{ fontSize: '13px', color: '#555', lineHeight: 1.6, background: '#F8F8F8', borderRadius: '10px', padding: '10px 14px', margin: 0 }}>
                {campaign.message}
              </p>
            )}

            {result && (
              <p style={{ fontSize: '13px', color: '#1a7a3a', fontWeight: 700, margin: 0 }}>
                ✅ Enviado a {result.sent} de {result.total} contactos.
              </p>
            )}

            {campaign.status === 'borrador' && (
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <button
                  onClick={() => handleSend(campaign)}
                  disabled={isSending}
                  style={{ background: isSending ? '#e0e0e0' : '#1a1a1a', color: isSending ? '#999' : '#C8FF00', fontWeight: 800, fontSize: '13px', border: 'none', borderRadius: '10px', padding: '9px 18px', cursor: isSending ? 'not-allowed' : 'pointer', opacity: isSending ? 0.6 : 1 }}
                >
                  {isSending ? 'Enviando...' : 'Enviar campaña'}
                </button>
                <button onClick={() => handleDelete(campaign)} style={{ background: 'transparent', color: '#E53935', fontWeight: 700, fontSize: '13px', border: '1px solid #f08080', borderRadius: '10px', padding: '9px 14px', cursor: 'pointer' }}>
                  Eliminar
                </button>
              </div>
            )}
          </div>
        );
      })}

      {/* Historial de envíos: campañas completadas dentro del rango elegido */}
      {(() => {
        const rangeDays = HISTORY_RANGES.find((r) => r.value === historyRange)?.days ?? 30;
        const rangeStart = Date.now() - rangeDays * 24 * 60 * 60 * 1000;
        const completadas = campaigns.filter(
          (c) => c.status === 'completada' && new Date(c.created_at).getTime() >= rangeStart,
        );

        return (
          <div style={{ background: '#fff', borderRadius: '16px', boxShadow: '0 2px 10px rgba(0,0,0,0.07)', overflow: 'hidden' }}>
            <button
              onClick={() => setHistoryOpen(!historyOpen)}
              style={{ width: '100%', background: 'none', border: 'none', padding: '16px 22px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', cursor: 'pointer', textAlign: 'left' }}
            >
              <span style={{ fontSize: '15px', fontWeight: 800, color: '#000' }}>
                📜 Historial de envíos
                <span style={{ fontSize: '12px', fontWeight: 600, color: '#999', marginLeft: '8px' }}>
                  {completadas.length} campaña{completadas.length !== 1 ? 's' : ''}
                </span>
              </span>
              <span style={{ fontSize: '12px', color: '#999', flexShrink: 0 }}>{historyOpen ? '▲' : '▼'}</span>
            </button>

            {historyOpen && (
              <div style={{ padding: '0 22px 18px 22px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {/* Filtros rápidos de fecha */}
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                  {HISTORY_RANGES.map((r) => (
                    <button
                      key={r.value}
                      onClick={() => setHistoryRange(r.value)}
                      style={{
                        background: historyRange === r.value ? '#1a1a1a' : '#F5F5F5',
                        color: historyRange === r.value ? '#C8FF00' : '#888',
                        fontWeight: 700, fontSize: '12px', border: 'none', borderRadius: '8px',
                        padding: '6px 12px', cursor: 'pointer',
                      }}
                    >
                      {r.label}
                    </button>
                  ))}
                </div>

                {completadas.length === 0 ? (
                  <p style={{ textAlign: 'center', padding: '20px 0', color: '#999', fontSize: '13px', margin: 0 }}>
                    No hay campañas completadas en este período.
                  </p>
                ) : (
                  completadas.map((c) => {
                    const isTemplate = c.type === 'template_meta';
                    const sent = c.recipient_ids?.length ?? c.sent_count ?? 0;
                    return (
                      <div key={c.id} style={{ background: '#F8F8F8', borderRadius: '12px', padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
                        <div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                            <p style={{ fontSize: '14px', fontWeight: 800, color: '#000', margin: 0 }}>{c.name}</p>
                            <span style={{ fontSize: '11px', background: isTemplate ? '#f0fff4' : '#fff', color: isTemplate ? '#1a7a3a' : '#888', border: isTemplate ? '1px solid #86efac' : '1px solid #e0e0e0', borderRadius: '6px', padding: '2px 8px', fontWeight: 700 }}>
                              {isTemplate ? '📋 Template' : '✏️ Texto'}
                            </span>
                          </div>
                          <p style={{ fontSize: '12px', color: '#999', margin: '3px 0 0 0' }}>
                            {new Date(c.created_at).toLocaleDateString('es-AR')}
                            {isTemplate && c.template_name && <> · Template: <strong style={{ color: '#555' }}>{c.template_name}</strong></>}
                            {' · '}{sent} destinatario{sent !== 1 ? 's' : ''}
                          </p>
                        </div>
                        <span style={{ background: '#e8fff0', color: '#1a7a3a', border: '1px solid #5ad87a', fontSize: '11px', fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase', padding: '4px 12px', borderRadius: '20px', whiteSpace: 'nowrap' }}>
                          Completada
                        </span>
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
}
