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
  exclude_campaign_ids: string[] | null;
};

type WaLine = { id: string; label: string | null; active: boolean; is_default: boolean };

type MetaTemplate = { name: string; language: string; status: string; body: string };

// Cuenta cuántos placeholders {{1}}, {{2}}... distintos tiene el body de una plantilla.
function countTemplateVars(body: string): number {
  const matches = body.match(/\{\{\s*(\d+)\s*\}\}/g);
  if (!matches) return 0;
  const nums = matches.map((m) => Number(m.replace(/[^\d]/g, '')));
  return Math.max(0, ...nums);
}

const STATUS_STYLE: Record<string, React.CSSProperties> = {
  borrador:   { background: '#F0F0F0', color: '#888' },
  enviando:   { background: '#fff8d6', color: '#b8860b', border: '1px solid #f0c040' },
  completada: { background: '#e8fff0', color: '#1a7a3a', border: '1px solid #5ad87a' },
};

const FILTERS = [
  { value: 'todos',          label: 'Todos los contactos' },
  { value: 'cliente_activo', label: 'Cliente activo' },
  { value: 'inactivo',       label: 'Inactivo' },
  { value: 'inactivo_dias',  label: 'Inactivo sin recargar X días' },
  { value: 'nuevo',          label: 'Nuevo' },
];

// 'inactivo_dias' es un sentinel de UI: el filtro real es inactivo_Xd, donde X
// son los días que escribe el usuario. effectiveFilter lo traduce al postear.
function effectiveFilter(f: string, days: number): string {
  return f === 'inactivo_dias' ? `inactivo_${days}d` : f;
}

// Etiqueta legible de un filtro guardado. Reconoce inactivo_Xd (que no está en
// FILTERS porque X es dinámico) para no mostrar el valor crudo en las tarjetas.
function filterLabel(value: string): string {
  const m = value.match(/^inactivo_(\d+)d$/);
  if (m) return `Inactivo sin recargar ${m[1]} días`;
  return FILTERS.find((f) => f.value === value)?.label ?? value;
}

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
  const [filter,           setFilter]           = useState('todos');
  const [inactiveDays,     setInactiveDays]     = useState(30);
  const [lineFilter,       setLineFilter]       = useState('todas');
  const [excludePrevious,  setExcludePrevious]  = useState(false);
  const [excludeCampaignIds, setExcludeCampaignIds] = useState<string[]>([]);
  const [sendLimit,        setSendLimit]        = useState('');
  const [templateName,     setTemplateName]     = useState('');
  const [templateLang,     setTemplateLang]     = useState('es');
  const [templateVars,     setTemplateVars]     = useState<string[]>(['']);

  // Plantillas aprobadas de Meta (selector visual para template_meta)
  const [metaTemplates,    setMetaTemplates]    = useState<MetaTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templatesError,   setTemplatesError]   = useState('');
  const [templatesLoaded,  setTemplatesLoaded]  = useState(false);
  const [manualTemplate,   setManualTemplate]   = useState(false);

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

  async function fetchTemplates() {
    setTemplatesLoading(true);
    setTemplatesError('');
    try {
      const res = await fetch('/api/campaigns/templates');
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setTemplatesError(data?.error || 'No se pudieron cargar las plantillas. Verificá el token en Configuración.');
        setMetaTemplates([]);
      } else {
        setMetaTemplates(Array.isArray(data) ? data : []);
      }
    } catch {
      setTemplatesError('No se pudieron cargar las plantillas. Verificá el token en Configuración.');
      setMetaTemplates([]);
    } finally {
      setTemplatesLoading(false);
      setTemplatesLoaded(true);
    }
  }

  // Al abrir el formulario, cargar las plantillas aprobadas (una sola vez).
  useEffect(() => {
    if (showForm && !templatesLoaded && !templatesLoading) {
      fetchTemplates();
    }
  }, [showForm, templatesLoaded, templatesLoading]);

  // Selección de una plantilla del selector: setea nombre, idioma y prepara los
  // inputs de variables según los placeholders {{n}} del body.
  function selectTemplate(t: MetaTemplate) {
    setTemplateName(t.name);
    setTemplateLang(t.language || 'es');
    const count = countTemplateVars(t.body);
    setTemplateVars(count > 0 ? Array(count).fill('') : ['']);
    setError('');
  }

  async function fetchRecipientCount(f: string, line: string) {
    setCountLoading(true);
    setRecipientCount(null);
    try {
      const isInactivoDays = /^inactivo_\d+d$/.test(f);
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
    fetchRecipientCount(effectiveFilter(f, inactiveDays), lineFilter);
  }

  function handleDaysChange(value: string) {
    const days = Math.min(365, Math.max(1, Number(value) || 1));
    setInactiveDays(days);
    if (filter === 'inactivo_dias') fetchRecipientCount(effectiveFilter('inactivo_dias', days), lineFilter);
  }

  function handleLineChange(l: string) {
    setLineFilter(l);
    fetchRecipientCount(effectiveFilter(filter, inactiveDays), l);
  }

  function resetForm() {
    setName(''); setFilter('todos'); setInactiveDays(30); setLineFilter('todas'); setSendLimit('');
    setTemplateName(''); setTemplateLang('es'); setTemplateVars(['']);
    setManualTemplate(false);
    setExcludePrevious(false); setExcludeCampaignIds([]);
    setError(''); setRecipientCount(null);
  }

  function prefillReactivacion() {
    setName('Reactivación — Bono 20%');
    setFilter('inactivo_dias');
    setInactiveDays(30);
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
    if (!templateName.trim()) { setError('Completá el nombre del template.'); return; }

    setCreating(true); setError('');
    try {
      const body: any = {
        name: name.trim(), target_filter: effectiveFilter(filter, inactiveDays), type: 'template_meta',
        send_limit: sendLimit ? Number(sendLimit) : null,
        target_number_id: lineFilter !== 'todas' ? lineFilter : null,
        exclude_campaign_ids: excludePrevious ? excludeCampaignIds : [],
        template_name:      templateName.trim(),
        template_language:  templateLang.trim() || 'es',
        template_variables: templateVars.filter(Boolean),
      };
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

          {/* Tipo: las campañas siempre usan Template Meta. */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label style={labelStyle}>Tipo de mensaje</label>
            <div style={{ padding: '10px 14px', borderRadius: '10px', fontWeight: 700, fontSize: '13px', border: '2px solid #C8FF00', background: '#f9ffe0', color: '#000', alignSelf: 'flex-start' }}>
              📋 Template Meta
            </div>
            <p style={{ fontSize: '11px', color: '#1a7a3a', margin: 0, fontWeight: 600 }}>Puede llegar a cualquier contacto. Requiere un template aprobado por Meta.</p>
          </div>

          {/* Destinatarios */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label style={labelStyle}>Destinatarios</label>
            <select value={filter} onChange={(e) => handleFilterChange(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
              {FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
            {filter === 'inactivo_dias' && (
              <>
                <label style={{ ...labelStyle, marginTop: '4px' }}>Días sin recargar</label>
                <input
                  type="number" min={1} max={365} value={inactiveDays}
                  onChange={(e) => handleDaysChange(e.target.value)}
                  placeholder="30"
                  style={inputStyle}
                />
                <p style={{ fontSize: '11px', color: '#bbb', margin: 0 }}>Contactos inactivos sin recarga verificada en los últimos {inactiveDays} días (1 a 365).</p>
              </>
            )}
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
                {filter === 'inactivo_dias' && !countLoading && (
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

          {/* Exclusión de contactos ya contactados */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <label style={{ fontSize: '13px', color: '#333', display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontWeight: 600 }}>
              <input
                type="checkbox"
                checked={excludePrevious}
                onChange={(e) => { setExcludePrevious(e.target.checked); if (!e.target.checked) setExcludeCampaignIds([]); }}
              />
              Excluir contactos de campañas anteriores
            </label>
            {excludePrevious && (() => {
              const completadas = campaigns.filter((c) => c.status === 'completada');
              if (completadas.length === 0) {
                return <p style={{ fontSize: '12px', color: '#bbb', margin: 0 }}>No hay campañas completadas para excluir todavía.</p>;
              }
              return (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', background: '#FAFAFA', borderRadius: '10px', padding: '12px' }}>
                  <p style={{ fontSize: '11px', color: '#888', margin: 0 }}>No se enviará a los contactos que ya recibieron las campañas tildadas.</p>
                  {completadas.map((c) => (
                    <label key={c.id} style={{ fontSize: '13px', color: '#333', display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={excludeCampaignIds.includes(c.id)}
                        onChange={(e) => {
                          setExcludeCampaignIds((prev) =>
                            e.target.checked ? [...prev, c.id] : prev.filter((id) => id !== c.id),
                          );
                        }}
                      />
                      {c.name}
                      <span style={{ color: '#aaa', fontSize: '11px' }}>· {new Date(c.created_at).toLocaleDateString('es-AR')}</span>
                    </label>
                  ))}
                </div>
              );
            })()}
          </div>

          {/* Contenido: selector visual de plantillas aprobadas de Meta */}
          <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                  <label style={labelStyle}>Plantilla aprobada</label>
                  {!templatesLoading && (
                    <button
                      type="button"
                      onClick={() => fetchTemplates()}
                      style={{ background: 'none', border: 'none', color: '#1a7a3a', fontWeight: 700, fontSize: '12px', cursor: 'pointer', padding: 0 }}
                    >
                      ↻ Recargar
                    </button>
                  )}
                </div>

                {templatesLoading && (
                  <p style={{ fontSize: '13px', color: '#888', margin: 0 }}>Cargando plantillas...</p>
                )}

                {!templatesLoading && templatesError && (
                  <div style={{ background: '#fff5f5', border: '1px solid #f08080', borderRadius: '10px', padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <p style={{ fontSize: '13px', color: '#c0392b', margin: 0, fontWeight: 600 }}>{templatesError}</p>
                    {!manualTemplate && (
                      <button type="button" onClick={() => setManualTemplate(true)} style={{ background: 'none', border: 'none', color: '#1a7a3a', fontWeight: 700, fontSize: '12px', cursor: 'pointer', padding: 0, alignSelf: 'flex-start' }}>
                        Ingresar el nombre manualmente →
                      </button>
                    )}
                  </div>
                )}

                {!templatesLoading && !templatesError && metaTemplates.length === 0 && (
                  <p style={{ fontSize: '13px', color: '#888', margin: 0 }}>
                    No hay plantillas aprobadas en este WABA. Creá una en Meta Business Manager y esperá su aprobación.
                  </p>
                )}

                {!templatesLoading && metaTemplates.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {metaTemplates.map((t) => {
                      const selected = templateName === t.name;
                      return (
                        <button
                          key={`${t.name}-${t.language}`}
                          type="button"
                          onClick={() => selectTemplate(t)}
                          style={{
                            textAlign: 'left', cursor: 'pointer', borderRadius: '12px', padding: '12px 14px',
                            border: selected ? '2px solid #1a7a3a' : '2px solid #e0e0e0',
                            background: selected ? '#f0fff4' : '#fff',
                            display: 'flex', flexDirection: 'column', gap: '6px',
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                            <code style={{ fontSize: '13px', fontWeight: 800, color: '#000', background: '#F5F5F5', borderRadius: '6px', padding: '2px 8px' }}>{t.name}</code>
                            <span style={{ fontSize: '11px', color: '#888' }}>{t.language}</span>
                            {selected && <span style={{ fontSize: '11px', color: '#1a7a3a', fontWeight: 800 }}>✓ Seleccionada</span>}
                          </div>
                          {t.body && (
                            <p style={{ fontSize: '12px', color: '#777', margin: 0, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{t.body}</p>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Fallback manual: solo si Meta no respondió y el usuario lo pidió */}
              {manualTemplate && (
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
              )}

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
          <strong>Template Meta:</strong> creá el template en Meta Business Manager y esperá su aprobación antes de enviar. Una vez aprobado, puede llegar a cualquier contacto.
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
                  Filtro: <strong>{filterLabel(campaign.target_filter)}</strong>
                  {campaign.target_number_id && (
                    <> · Línea: <strong>{lines.find((l) => l.id === campaign.target_number_id)?.label ?? campaign.target_number_id}</strong></>
                  )}
                  {' · '}{new Date(campaign.created_at).toLocaleDateString('es-AR')}
                  {campaign.sent_count > 0 && ` · ${campaign.sent_count} enviados`}
                  {campaign.exclude_campaign_ids && campaign.exclude_campaign_ids.length > 0 && (
                    <> · Excluye {campaign.exclude_campaign_ids.length} campaña{campaign.exclude_campaign_ids.length !== 1 ? 's' : ''}</>
                  )}
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
