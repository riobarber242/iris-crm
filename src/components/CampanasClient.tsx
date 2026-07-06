"use client";

import React, { useEffect, useState } from 'react';

type Campaign = {
  id: string;
  name: string;
  type: 'texto_libre' | 'template_meta';
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
  delivered_count: number | null;
  read_count: number | null;
  failed_count: number | null;
  btn1_count: number | null;
  btn2_count: number | null;
};

type WaLine = { id: string; label: string | null; active: boolean; is_default: boolean };

// Plantilla guardada en Iris (tabla whatsapp_templates), con sus botones.
type IrisTemplate = { id: string; name: string; language: string; body: string; buttons: string[] };

// Contacto seleccionable en el modo "elegir contactos" (agendados con usuario).
type PickContact = { id: string; name: string | null; phone: string; casino_username: string | null };

// Cuenta cuántos placeholders {{1}}, {{2}}... distintos tiene el body.
function countTemplateVars(body: string): number {
  const matches = body.match(/\{\{\s*(\d+)\s*\}\}/g);
  if (!matches) return 0;
  const nums = matches.map((m) => Number(m.replace(/[^\d]/g, '')));
  return Math.max(0, ...nums);
}

const FILTERS = [
  { value: 'todos',          label: 'Todos los contactos' },
  { value: 'cliente_activo', label: 'Cliente activo' },
  { value: 'inactivo',       label: 'Inactivo' },
  { value: 'inactivo_dias',  label: 'Inactivo sin recargar X días' },
  { value: 'nuevo',          label: 'Nuevo' },
];

// 'inactivo_dias' es un sentinel de UI: el filtro real es inactivo_Xd.
function effectiveFilter(f: string, days: number): string {
  return f === 'inactivo_dias' ? `inactivo_${days}d` : f;
}

function filterLabel(value: string): string {
  if (value === 'seleccion') return 'Contactos seleccionados';
  const m = value.match(/^inactivo_(\d+)d$/);
  if (m) return `Inactivo sin recargar ${m[1]} días`;
  return FILTERS.find((f) => f.value === value)?.label ?? value;
}

const HISTORY_RANGES = [
  { value: '7d',  label: '7 días',  days: 7 },
  { value: '15d', label: '15 días', days: 15 },
  { value: '1m',  label: '1 mes',   days: 30 },
  { value: '3m',  label: '3 meses', days: 90 },
  { value: '1y',  label: '1 año',   days: 365 },
];

const STEPS = ['Plantilla', 'Destinatarios', 'Configuración', 'Confirmar'];

const inputStyle: React.CSSProperties = {
  background: '#F5F5F5', border: 'none', borderRadius: '10px',
  padding: '10px 14px', fontSize: '14px', color: '#000', outline: 'none', width: '100%',
  boxSizing: 'border-box',
};

const labelStyle: React.CSSProperties = {
  fontSize: '11px', fontWeight: 700, color: '#999',
  textTransform: 'uppercase', letterSpacing: '0.08em',
};

const cardStyle: React.CSSProperties = {
  background: '#fff', borderRadius: '16px', padding: '20px 24px',
  boxShadow: '0 2px 12px rgba(0,0,0,0.08)', display: 'flex', flexDirection: 'column', gap: '16px',
};

// Chip de métrica para el historial.
function Chip({ label, value, color, bg }: { label: string; value: number; color: string; bg: string }) {
  return (
    <span style={{ fontSize: '11px', fontWeight: 800, color, background: bg, borderRadius: '8px', padding: '3px 10px', whiteSpace: 'nowrap' }}>
      {value} {label}
    </span>
  );
}

export default function CampanasClient() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [lines,     setLines]     = useState<WaLine[]>([]);
  const [showWizard, setShowWizard] = useState(false);
  const [step,       setStep]       = useState(1);

  // Wizard — datos
  const [name,         setName]         = useState('');
  const [templates,    setTemplates]    = useState<IrisTemplate[]>([]);
  const [tplLoading,   setTplLoading]   = useState(false);
  const [tplError,     setTplError]     = useState('');
  const [tplLoaded,    setTplLoaded]    = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [templateLang, setTemplateLang] = useState('es');
  const [templateBody, setTemplateBody] = useState('');
  const [templateButtons, setTemplateButtons] = useState<string[]>([]);
  const [templateVars, setTemplateVars] = useState<string[]>([]);

  const [filter,       setFilter]       = useState('todos');
  const [inactiveDays, setInactiveDays] = useState(30);
  const [lineFilter,   setLineFilter]   = useState('todas');
  const [recipientCount, setRecipientCount] = useState<number | null>(null);
  const [countLoading,   setCountLoading]   = useState(false);

  // Modo de destinatarios: por categoría (filtro) o selección individual (ids).
  const [targetMode,      setTargetMode]      = useState<'category' | 'individual'>('category');
  const [contactsList,    setContactsList]    = useState<PickContact[]>([]);
  const [contactsLoading, setContactsLoading] = useState(false);
  const [contactsLoaded,  setContactsLoaded]  = useState(false);
  const [selectedIds,     setSelectedIds]     = useState<string[]>([]);
  const [contactSearch,   setContactSearch]   = useState('');

  const [sendLimit,    setSendLimit]    = useState('');
  const [intervalMin,  setIntervalMin]  = useState('1');
  const [intervalMax,  setIntervalMax]  = useState('3');
  const [pauseEvery,   setPauseEvery]   = useState('');
  const [pauseSeconds, setPauseSeconds] = useState('');
  const [excludePrevious,   setExcludePrevious]   = useState(false);
  const [excludeCampaignIds, setExcludeCampaignIds] = useState<string[]>([]);

  const [launching,   setLaunching]   = useState(false);
  const [launchProgress, setLaunchProgress] = useState('');
  const [error,       setError]       = useState('');
  const [launchResult, setLaunchResult] = useState<{ sent: number; total: number } | null>(null);
  const [deletingNo,  setDeletingNo]  = useState<string | null>(null);

  const [historyOpen,  setHistoryOpen]  = useState(true);
  const [historyRange, setHistoryRange] = useState('1m');

  const activeCampaigns = campaigns.filter((c) => c.status !== 'completada');

  async function fetchCampaigns() {
    try {
      const res = await fetch('/api/campaigns');
      if (!res.ok) return;
      setCampaigns(await res.json());
    } catch {}
  }

  useEffect(() => {
    fetchCampaigns();
    fetch('/api/whatsapp-numbers')
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setLines(Array.isArray(d) ? d : []))
      .catch(() => {});
    const t = setInterval(fetchCampaigns, 10_000);
    return () => clearInterval(t);
  }, []);

  async function fetchTemplates() {
    setTplLoading(true); setTplError('');
    try {
      const res = await fetch('/api/whatsapp-templates');
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setTplError(data?.error || 'No se pudieron cargar las plantillas. Creá una en Configuración.');
        setTemplates([]);
      } else {
        setTemplates(Array.isArray(data) ? data : []);
      }
    } catch {
      setTplError('No se pudieron cargar las plantillas. Creá una en Configuración.');
      setTemplates([]);
    } finally {
      setTplLoading(false); setTplLoaded(true);
    }
  }

  // Al abrir el wizard, cargar las plantillas de Iris (una sola vez).
  useEffect(() => {
    if (showWizard && !tplLoaded && !tplLoading) fetchTemplates();
  }, [showWizard, tplLoaded, tplLoading]);

  function selectTemplate(t: IrisTemplate) {
    setTemplateName(t.name);
    setTemplateLang(t.language || 'es');
    setTemplateBody(t.body || '');
    setTemplateButtons(Array.isArray(t.buttons) ? t.buttons : []);
    const count = countTemplateVars(t.body || '');
    setTemplateVars(count > 0 ? Array(count).fill('') : []);
    setError('');
  }

  async function fetchRecipientCount(f: string, line: string) {
    setCountLoading(true); setRecipientCount(null);
    try {
      const isInactivoDays = /^inactivo_\d+d$/.test(f);
      const param = isInactivoDays ? `?status=inactivo` : f === 'todos' ? '?all=true' : `?status=${f}`;
      const lineParam = line !== 'todas' ? `&number=${line}` : '';
      const res = await fetch(`/api/contacts${param}${lineParam}`);
      if (!res.ok) return;
      const data = await res.json();
      // El endpoint ahora devuelve { count } (conteo agregado en SQL). Fallback al
      // array por compatibilidad si algún deploy viejo respondiera la lista.
      setRecipientCount(
        typeof data?.count === 'number' ? data.count : Array.isArray(data) ? data.length : null,
      );
    } catch {}
    setCountLoading(false);
  }

  // Carga la lista de agendados (con usuario) para el picker individual. Una vez.
  async function fetchContactsList() {
    setContactsLoading(true);
    try {
      const res  = await fetch('/api/contacts');
      const data = res.ok ? await res.json() : [];
      setContactsList(Array.isArray(data) ? data : []);
    } catch {
      setContactsList([]);
    } finally {
      setContactsLoading(false); setContactsLoaded(true);
    }
  }

  function handleTargetModeChange(mode: 'category' | 'individual') {
    setTargetMode(mode);
    setError('');
    if (mode === 'individual' && !contactsLoaded && !contactsLoading) fetchContactsList();
  }

  function toggleContact(id: string) {
    setSelectedIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
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

  function resetWizard() {
    setStep(1); setName('');
    setTemplateName(''); setTemplateLang('es'); setTemplateBody(''); setTemplateButtons([]); setTemplateVars([]);
    setFilter('todos'); setInactiveDays(30); setLineFilter('todas'); setRecipientCount(null);
    setTargetMode('category'); setSelectedIds([]); setContactSearch('');
    setSendLimit(''); setIntervalMin('1'); setIntervalMax('3'); setPauseEvery(''); setPauseSeconds('');
    setExcludePrevious(false); setExcludeCampaignIds([]);
    setError('');
  }

  function openWizard() {
    resetWizard(); setShowWizard(true); setLaunchResult(null);
    fetchRecipientCount('todos', 'todas');
  }
  function closeWizard() { resetWizard(); setShowWizard(false); }

  function canAdvance(): boolean {
    if (step === 1) return !!name.trim() && !!templateName.trim();
    if (step === 2) return targetMode === 'individual' ? selectedIds.length > 0 : true;
    if (step === 3) {
      const lo = Number(intervalMin), hi = Number(intervalMax);
      return !isNaN(lo) && !isNaN(hi) && lo >= 0 && hi >= lo;
    }
    return true;
  }

  function next() {
    if (!canAdvance()) {
      if (step === 1) setError('Completá el nombre y elegí una plantilla.');
      else if (step === 2) setError('Elegí al menos un contacto.');
      else if (step === 3) setError('El intervalo mínimo no puede ser mayor que el máximo.');
      return;
    }
    setError(''); setStep((s) => Math.min(4, s + 1));
  }
  function back() { setError(''); setStep((s) => Math.max(1, s - 1)); }

  async function launch() {
    setLaunching(true); setError(''); setLaunchProgress('');
    try {
      const isIndividual = targetMode === 'individual';
      const createBody = {
        name: name.trim(),
        target_filter: isIndividual ? 'seleccion' : effectiveFilter(filter, inactiveDays),
        type: 'template_meta',
        template_name: templateName.trim(),
        template_language: templateLang.trim() || 'es',
        template_variables: templateVars.filter((v) => v.trim() !== ''),
        // En individual: sin límite/exclusión y sin filtro de línea (cada contacto
        // sale por su propio número). recipient_ids manda la lista elegida.
        send_limit: isIndividual ? null : (sendLimit ? Number(sendLimit) : null),
        target_number_id: isIndividual ? null : (lineFilter !== 'todas' ? lineFilter : null),
        exclude_campaign_ids: isIndividual ? [] : (excludePrevious ? excludeCampaignIds : []),
        recipient_ids: isIndividual ? selectedIds : [],
        interval_min_sec: Number(intervalMin) || 0,
        interval_max_sec: Number(intervalMax) || 0,
        pause_every:   pauseEvery ? Number(pauseEvery) : null,
        pause_seconds: pauseSeconds ? Number(pauseSeconds) : null,
      };
      const res = await fetch('/api/campaigns', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(createBody),
      });
      if (!res.ok) throw new Error(await res.text());
      const campaign = await res.json();

      // Auto-resume: /send corta por presupuesto de tiempo en campañas grandes y
      // devuelve done:false; lo re-llamamos hasta done:true (saltea a los ya
      // intentados server-side). El guard es un backstop ante un bucle inesperado.
      let done = false, guard = 0, sentTotal = 0, total = 0;
      while (!done) {
        if (++guard > 300) throw new Error('El envío no terminó tras muchos reintentos; revisá el estado de la campaña.');
        const sendRes = await fetch('/api/campaigns/send', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ campaignId: campaign.id }),
        });
        const data = await sendRes.json();
        if (!sendRes.ok) throw new Error(data?.error ?? 'Error al enviar la campaña.');
        done      = data.done !== false;                          // sin done → compat: tratamos como terminado
        sentTotal = data.sentTotal ?? data.sent ?? sentTotal;
        total     = data.total ?? total;
        if (!done) setLaunchProgress(`Enviando ${data.attemptedTotal ?? sentTotal} / ${total}…`);
      }

      setLaunchResult({ sent: sentTotal, total });
      closeWizard();
      fetchCampaigns();
    } catch (e: any) {
      setError(e.message ?? 'Error al lanzar la campaña.');
    }
    setLaunching(false);
    setLaunchProgress('');
  }

  async function handleDelete(campaign: Campaign) {
    if (!confirm(`¿Eliminar la campaña "${campaign.name}"?`)) return;
    try {
      await fetch('/api/campaigns', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ campaignId: campaign.id }),
      });
      fetchCampaigns();
    } catch {}
  }

  async function handleDeleteNo(c: Campaign) {
    const n = c.btn2_count ?? 0;
    if (!confirm(`¿Eliminar los ${n} contacto${n !== 1 ? 's' : ''} que respondieron "No" en "${c.name}"? Esta acción no se puede deshacer.`)) return;
    setDeletingNo(c.id);
    try {
      const res = await fetch(`/api/campaigns/${c.id}/delete-no`, { method: 'POST' });
      const data = await res.json();
      if (res.ok) alert(`${data.deleted} contacto${data.deleted !== 1 ? 's' : ''} eliminado${data.deleted !== 1 ? 's' : ''}.`);
      else alert(`Error: ${data?.error ?? res.statusText}`);
    } catch { alert('Error de red al eliminar contactos.'); }
    setDeletingNo(null);
    fetchCampaigns();
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontSize: '22px', fontWeight: 900, color: '#000', margin: 0 }}>Campañas</h1>
          <p style={{ fontSize: '13px', color: '#999', margin: '4px 0 0 0' }}>Mensajes masivos con plantillas de WhatsApp.</p>
        </div>
        <button
          onClick={() => (showWizard ? closeWizard() : openWizard())}
          style={{ background: '#1a1a1a', color: '#C8FF00', fontWeight: 800, fontSize: '13px', border: 'none', borderRadius: '12px', padding: '10px 20px', cursor: 'pointer' }}
        >
          {showWizard ? '✕ Cancelar' : '+ Nueva campaña'}
        </button>
      </div>

      {launchResult && (
        <div style={{ background: '#e8fff0', border: '1px solid #5ad87a', borderRadius: '12px', padding: '12px 16px' }}>
          <p style={{ fontSize: '13px', color: '#1a7a3a', fontWeight: 700, margin: 0 }}>
            ✅ Campaña lanzada: enviada a {launchResult.sent} de {launchResult.total} contactos.
          </p>
        </div>
      )}

      {/* Wizard */}
      {showWizard && (
        <div style={cardStyle}>
          {/* Barra de progreso */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            {STEPS.map((label, i) => {
              const n = i + 1;
              const done = n < step, current = n === step;
              return (
                <React.Fragment key={label}>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
                    <div style={{
                      width: '28px', height: '28px', borderRadius: '50%',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: '13px', fontWeight: 800,
                      background: done ? '#1a7a3a' : current ? '#C8FF00' : '#eee',
                      color: done ? '#fff' : current ? '#000' : '#999',
                    }}>
                      {done ? '✓' : n}
                    </div>
                    <span style={{ fontSize: '10px', fontWeight: 700, color: current ? '#000' : '#aaa', whiteSpace: 'nowrap' }}>{label}</span>
                  </div>
                  {n < STEPS.length && (
                    <div style={{ flex: 1, height: '2px', background: n < step ? '#1a7a3a' : '#eee', marginBottom: '16px' }} />
                  )}
                </React.Fragment>
              );
            })}
          </div>

          {/* ── PASO 1: Plantilla ── */}
          {step === 1 && (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <label style={labelStyle}>Nombre de la campaña</label>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej: Promo junio 2026" style={inputStyle} />
              </div>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <label style={labelStyle}>Plantilla de Iris</label>
                {!tplLoading && (
                  <button type="button" onClick={fetchTemplates} style={{ background: 'none', border: 'none', color: '#1a7a3a', fontWeight: 700, fontSize: '12px', cursor: 'pointer', padding: 0 }}>↻ Recargar</button>
                )}
              </div>

              {tplLoading && <p style={{ fontSize: '13px', color: '#888', margin: 0 }}>Cargando plantillas…</p>}
              {!tplLoading && tplError && <p style={{ fontSize: '13px', color: '#c0392b', margin: 0, fontWeight: 600 }}>{tplError}</p>}
              {!tplLoading && !tplError && templates.length === 0 && (
                <p style={{ fontSize: '13px', color: '#888', margin: 0 }}>No hay plantillas guardadas. Creá una en Configuración → Plantillas de WhatsApp.</p>
              )}

              {!tplLoading && templates.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {templates.map((t) => {
                    const selected = templateName === t.name;
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => selectTemplate(t)}
                        style={{
                          textAlign: 'left', cursor: 'pointer', borderRadius: '12px', padding: '12px 14px',
                          border: selected ? '2px solid #1a7a3a' : '2px solid #e0e0e0',
                          background: selected ? '#f0fff4' : '#fff', display: 'flex', flexDirection: 'column', gap: '6px',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                          <code style={{ fontSize: '13px', fontWeight: 800, color: '#000', background: '#F5F5F5', borderRadius: '6px', padding: '2px 8px' }}>{t.name}</code>
                          <span style={{ fontSize: '11px', color: '#888' }}>{t.language}</span>
                          {selected && <span style={{ fontSize: '11px', color: '#1a7a3a', fontWeight: 800 }}>✓ Seleccionada</span>}
                        </div>
                        {t.body && <p style={{ fontSize: '12px', color: '#777', margin: 0, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{t.body}</p>}
                        {Array.isArray(t.buttons) && t.buttons.length > 0 && (
                          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                            {t.buttons.map((b, i) => (
                              <span key={i} style={{ fontSize: '11px', fontWeight: 700, color: '#1a7a3a', background: '#eaffd1', borderRadius: '8px', padding: '3px 10px' }}>{b}</span>
                            ))}
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Variables del template */}
              {templateVars.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <label style={labelStyle}>Variables del template</label>
                  <p style={{ fontSize: '11px', color: '#1a7a3a', margin: 0, fontWeight: 600 }}>
                    Usá <code>{'{{nombre}}'}</code> para que cada contacto reciba su nombre (o su teléfono si no tiene).
                  </p>
                  {templateVars.map((v, i) => (
                    <div key={i} style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                      <span style={{ fontSize: '12px', color: '#aaa', minWidth: '28px' }}>{`{{${i + 1}}}`}</span>
                      <input
                        value={v}
                        onChange={(e) => { const nx = [...templateVars]; nx[i] = e.target.value; setTemplateVars(nx); }}
                        placeholder={`Valor de {{${i + 1}}}`}
                        style={{ ...inputStyle, flex: 1 }}
                      />
                      <button
                        type="button"
                        onClick={() => { const nx = [...templateVars]; nx[i] = '{{nombre}}'; setTemplateVars(nx); }}
                        title="Insertar el nombre del contacto"
                        style={{ background: '#f0fff4', border: '1px solid #86efac', borderRadius: '8px', padding: '8px 10px', fontSize: '11px', color: '#1a7a3a', fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0 }}
                      >
                        + {'{{nombre}}'}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {/* ── PASO 2: Destinatarios ── */}
          {step === 2 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {/* Toggle de modo: por categoría vs elegir contactos */}
              <div style={{ display: 'flex', gap: '6px' }}>
                {([['category', 'Por categoría'], ['individual', 'Elegir contactos']] as const).map(([mode, lbl]) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => handleTargetModeChange(mode)}
                    style={{
                      flex: 1, padding: '9px 12px', fontSize: '13px', fontWeight: 700, cursor: 'pointer',
                      borderRadius: '10px', border: targetMode === mode ? '2px solid #1a7a3a' : '2px solid #e0e0e0',
                      background: targetMode === mode ? '#f0fff4' : '#fff', color: targetMode === mode ? '#1a7a3a' : '#888',
                    }}
                  >
                    {lbl}
                  </button>
                ))}
              </div>

              {/* ── Modo categoría ── */}
              {targetMode === 'category' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <label style={labelStyle}>Destinatarios</label>
                  <select value={filter} onChange={(e) => handleFilterChange(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
                    {FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                  </select>

                  {filter === 'inactivo_dias' && (
                    <>
                      <label style={{ ...labelStyle, marginTop: '4px' }}>Días sin recargar</label>
                      <input type="number" min={1} max={365} value={inactiveDays} onChange={(e) => handleDaysChange(e.target.value)} placeholder="30" style={inputStyle} />
                      <p style={{ fontSize: '11px', color: '#bbb', margin: 0 }}>Inactivos sin recarga verificada en los últimos {inactiveDays} días (1 a 365).</p>
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
                    <p style={{ fontSize: '12px', color: '#555', margin: '4px 0 0 0', fontWeight: 600 }}>
                      {countLoading ? 'Contando…' : `~${recipientCount} contacto${recipientCount !== 1 ? 's' : ''}`}
                      {filter === 'inactivo_dias' && !countLoading && <span style={{ color: '#888', fontWeight: 400 }}> (estimado — el filtro exacto aplica al enviar)</span>}
                    </p>
                  )}
                </div>
              )}

              {/* ── Modo individual: buscador + lista con checkboxes ── */}
              {targetMode === 'individual' && (() => {
                const q = contactSearch.trim().toLowerCase();
                const visible = q
                  ? contactsList.filter((c) =>
                      (c.casino_username ?? '').toLowerCase().includes(q) ||
                      (c.name ?? '').toLowerCase().includes(q) ||
                      (c.phone ?? '').toLowerCase().includes(q))
                  : contactsList;
                const visibleIds = visible.map((c) => c.id);
                const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.includes(id));
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <input
                      value={contactSearch}
                      onChange={(e) => setContactSearch(e.target.value)}
                      placeholder="Buscar por usuario, nombre o teléfono…"
                      style={inputStyle}
                    />
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                      <span style={{ fontSize: '12px', fontWeight: 700, color: '#1a7a3a' }}>
                        {selectedIds.length} seleccionado{selectedIds.length !== 1 ? 's' : ''}
                      </span>
                      <div style={{ display: 'flex', gap: '10px' }}>
                        <button
                          type="button"
                          onClick={() => setSelectedIds((prev) => allVisibleSelected
                            ? prev.filter((id) => !visibleIds.includes(id))
                            : Array.from(new Set([...prev, ...visibleIds])))}
                          disabled={visibleIds.length === 0}
                          style={{ background: 'none', border: 'none', color: visibleIds.length === 0 ? '#ccc' : '#1a7a3a', fontWeight: 700, fontSize: '12px', cursor: visibleIds.length === 0 ? 'default' : 'pointer', padding: 0 }}
                        >
                          {allVisibleSelected ? 'Quitar visibles' : 'Seleccionar visibles'}
                        </button>
                        {selectedIds.length > 0 && (
                          <button type="button" onClick={() => setSelectedIds([])} style={{ background: 'none', border: 'none', color: '#E53935', fontWeight: 700, fontSize: '12px', cursor: 'pointer', padding: 0 }}>
                            Limpiar
                          </button>
                        )}
                      </div>
                    </div>

                    {contactsLoading ? (
                      <p style={{ fontSize: '13px', color: '#888', margin: 0 }}>Cargando contactos…</p>
                    ) : contactsList.length === 0 ? (
                      <p style={{ fontSize: '13px', color: '#888', margin: 0 }}>No hay contactos agendados (con usuario) para elegir.</p>
                    ) : (
                      <div style={{ maxHeight: '320px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px', border: '1px solid #eee', borderRadius: '10px', padding: '6px' }}>
                        {visible.length === 0 ? (
                          <p style={{ fontSize: '13px', color: '#aaa', margin: 0, padding: '8px' }}>Sin resultados para “{contactSearch}”.</p>
                        ) : visible.map((c) => {
                          const checked = selectedIds.includes(c.id);
                          return (
                            <label key={c.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 10px', borderRadius: '8px', cursor: 'pointer', background: checked ? '#f0fff4' : 'transparent' }}>
                              <input type="checkbox" checked={checked} onChange={() => toggleContact(c.id)} />
                              <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                                <span style={{ fontSize: '13px', fontWeight: 700, color: '#000', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {c.casino_username || c.name || c.phone}
                                </span>
                                <span style={{ fontSize: '11px', color: '#999' }}>{c.phone}</span>
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          )}

          {/* ── PASO 3: Configuración ── */}
          {step === 3 && (
            <>
              <div style={{ display: 'flex', gap: '10px' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', flex: 1 }}>
                  <label style={labelStyle}>Intervalo mín. (seg)</label>
                  <input type="number" min={0} value={intervalMin} onChange={(e) => setIntervalMin(e.target.value)} style={inputStyle} />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', flex: 1 }}>
                  <label style={labelStyle}>Intervalo máx. (seg)</label>
                  <input type="number" min={0} value={intervalMax} onChange={(e) => setIntervalMax(e.target.value)} style={inputStyle} />
                </div>
              </div>
              <p style={{ fontSize: '11px', color: '#bbb', margin: 0 }}>Entre cada mensaje se espera un tiempo al azar dentro de ese rango (evita parecer spam).</p>

              {targetMode === 'category' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <label style={labelStyle}>Límite de contactos (opcional)</label>
                  <input type="number" min={1} value={sendLimit} onChange={(e) => setSendLimit(e.target.value)} placeholder="Sin límite" style={inputStyle} />
                </div>
              )}

              <div style={{ display: 'flex', gap: '10px' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', flex: 1 }}>
                  <label style={labelStyle}>Pausar cada (mensajes)</label>
                  <input type="number" min={1} value={pauseEvery} onChange={(e) => setPauseEvery(e.target.value)} placeholder="Sin pausa" style={inputStyle} />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', flex: 1 }}>
                  <label style={labelStyle}>Duración pausa (seg)</label>
                  <input type="number" min={1} value={pauseSeconds} onChange={(e) => setPauseSeconds(e.target.value)} placeholder="0" style={inputStyle} />
                </div>
              </div>

              {targetMode === 'category' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <label style={{ fontSize: '13px', color: '#333', display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontWeight: 600 }}>
                  <input type="checkbox" checked={excludePrevious} onChange={(e) => { setExcludePrevious(e.target.checked); if (!e.target.checked) setExcludeCampaignIds([]); }} />
                  Excluir contactos de campañas anteriores
                </label>
                {excludePrevious && (() => {
                  const completadas = campaigns.filter((c) => c.status === 'completada');
                  if (completadas.length === 0) return <p style={{ fontSize: '12px', color: '#bbb', margin: 0 }}>No hay campañas completadas para excluir todavía.</p>;
                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', background: '#FAFAFA', borderRadius: '10px', padding: '12px' }}>
                      {completadas.map((c) => (
                        <label key={c.id} style={{ fontSize: '13px', color: '#333', display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                          <input
                            type="checkbox"
                            checked={excludeCampaignIds.includes(c.id)}
                            onChange={(e) => setExcludeCampaignIds((prev) => e.target.checked ? [...prev, c.id] : prev.filter((id) => id !== c.id))}
                          />
                          {c.name}
                        </label>
                      ))}
                    </div>
                  );
                })()}
              </div>
              )}
            </>
          )}

          {/* ── PASO 4: Confirmar ── */}
          {step === 4 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <p style={{ fontSize: '15px', fontWeight: 800, color: '#000', margin: 0 }}>Revisá antes de lanzar</p>
              <div style={{ background: '#F8F8F8', borderRadius: '12px', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '13px', color: '#333' }}>
                <div><strong>Nombre:</strong> {name}</div>
                <div><strong>Plantilla:</strong> <code>{templateName}</code> · {templateLang}</div>
                {templateButtons.length > 0 && (
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
                    <strong>Botones:</strong>
                    {templateButtons.map((b, i) => <span key={i} style={{ fontSize: '11px', fontWeight: 700, color: '#1a7a3a', background: '#eaffd1', borderRadius: '8px', padding: '3px 10px' }}>{b}</span>)}
                  </div>
                )}
                {templateVars.length > 0 && <div><strong>Variables:</strong> {templateVars.map((v, i) => `{{${i + 1}}}=${v || '—'}`).join(', ')}</div>}
                <div><strong>Destinatarios:</strong> {targetMode === 'individual'
                  ? `${selectedIds.length} contacto${selectedIds.length !== 1 ? 's' : ''} seleccionado${selectedIds.length !== 1 ? 's' : ''}`
                  : `${filterLabel(effectiveFilter(filter, inactiveDays))}${recipientCount !== null ? ` (~${recipientCount})` : ''}`}</div>
                {targetMode === 'category' && lineFilter !== 'todas' && <div><strong>Línea:</strong> {lines.find((l) => l.id === lineFilter)?.label ?? lineFilter}</div>}
                <div><strong>Ritmo:</strong> {intervalMin}–{intervalMax}s entre mensajes{pauseEvery && pauseSeconds ? ` · pausa de ${pauseSeconds}s cada ${pauseEvery}` : ''}</div>
                {targetMode === 'category' && sendLimit && <div><strong>Límite:</strong> {sendLimit} contactos</div>}
                {targetMode === 'category' && excludePrevious && excludeCampaignIds.length > 0 && <div><strong>Excluye:</strong> {excludeCampaignIds.length} campaña(s)</div>}
              </div>
              <div style={{ background: '#fffbe6', border: '1px solid #f0c040', borderRadius: '12px', padding: '10px 14px' }}>
                <p style={{ fontSize: '12px', color: '#7a5c00', margin: 0, lineHeight: 1.5 }}>
                  ⚠️ Al lanzar, la campaña se envía inmediatamente. No se puede deshacer.
                </p>
              </div>
            </div>
          )}

          {error && <p style={{ fontSize: '13px', color: '#E53935', fontWeight: 600, margin: 0 }}>{error}</p>}

          {/* Navegación */}
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
            <button
              type="button"
              onClick={back}
              disabled={step === 1}
              style={{ background: '#F5F5F5', color: step === 1 ? '#ccc' : '#333', fontWeight: 700, fontSize: '13px', border: 'none', borderRadius: '10px', padding: '10px 18px', cursor: step === 1 ? 'not-allowed' : 'pointer' }}
            >
              ← Atrás
            </button>
            {step < 4 ? (
              <button type="button" onClick={next} style={{ background: '#1a1a1a', color: '#C8FF00', fontWeight: 800, fontSize: '13px', border: 'none', borderRadius: '10px', padding: '10px 22px', cursor: 'pointer' }}>
                Siguiente →
              </button>
            ) : (
              <button type="button" onClick={launch} disabled={launching} style={{ background: launching ? '#e0e0e0' : '#C8FF00', color: '#000', fontWeight: 800, fontSize: '14px', border: 'none', borderRadius: '10px', padding: '10px 22px', cursor: launching ? 'not-allowed' : 'pointer', opacity: launching ? 0.6 : 1 }}>
                {launching ? (launchProgress || 'Lanzando…') : '🚀 Lanzar campaña'}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Campañas activas (borrador / enviando) */}
      {activeCampaigns.map((c) => (
        <div key={c.id} style={{ ...cardStyle, gap: '10px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
            <div>
              <p style={{ fontSize: '16px', fontWeight: 800, color: '#000', margin: 0 }}>{c.name}</p>
              <p style={{ fontSize: '12px', color: '#aaa', margin: '3px 0 0 0' }}>
                {filterLabel(c.target_filter)} · {new Date(c.created_at).toLocaleDateString('es-AR')}
                {c.template_name && <> · <code>{c.template_name}</code></>}
              </p>
            </div>
            <span style={{ background: c.status === 'enviando' ? '#fff8d6' : '#F0F0F0', color: c.status === 'enviando' ? '#b8860b' : '#888', fontSize: '11px', fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase', padding: '4px 12px', borderRadius: '20px', whiteSpace: 'nowrap' }}>
              {c.status}
            </span>
          </div>
          {c.status === 'borrador' && (
            <button onClick={() => handleDelete(c)} style={{ alignSelf: 'flex-start', background: 'transparent', color: '#E53935', fontWeight: 700, fontSize: '13px', border: '1px solid #f08080', borderRadius: '10px', padding: '8px 14px', cursor: 'pointer' }}>
              Eliminar
            </button>
          )}
        </div>
      ))}

      {/* Historial con métricas */}
      {(() => {
        const rangeDays = HISTORY_RANGES.find((r) => r.value === historyRange)?.days ?? 30;
        const rangeStart = Date.now() - rangeDays * 86_400_000;
        const completadas = campaigns.filter((c) => c.status === 'completada' && new Date(c.created_at).getTime() >= rangeStart);

        return (
          <div style={{ background: '#fff', borderRadius: '16px', boxShadow: '0 2px 10px rgba(0,0,0,0.07)', overflow: 'hidden' }}>
            <button onClick={() => setHistoryOpen(!historyOpen)} style={{ width: '100%', background: 'none', border: 'none', padding: '16px 22px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', cursor: 'pointer', textAlign: 'left' }}>
              <span style={{ fontSize: '15px', fontWeight: 800, color: '#000' }}>
                📜 Historial de envíos
                <span style={{ fontSize: '12px', fontWeight: 600, color: '#999', marginLeft: '8px' }}>{completadas.length} campaña{completadas.length !== 1 ? 's' : ''}</span>
              </span>
              <span style={{ fontSize: '12px', color: '#999' }}>{historyOpen ? '▲' : '▼'}</span>
            </button>

            {historyOpen && (
              <div style={{ padding: '0 22px 18px 22px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                  {HISTORY_RANGES.map((r) => (
                    <button key={r.value} onClick={() => setHistoryRange(r.value)} style={{ background: historyRange === r.value ? '#1a1a1a' : '#F5F5F5', color: historyRange === r.value ? '#C8FF00' : '#888', fontWeight: 700, fontSize: '12px', border: 'none', borderRadius: '8px', padding: '6px 12px', cursor: 'pointer' }}>
                      {r.label}
                    </button>
                  ))}
                </div>

                {completadas.length === 0 ? (
                  <p style={{ textAlign: 'center', padding: '20px 0', color: '#999', fontSize: '13px', margin: 0 }}>No hay campañas completadas en este período.</p>
                ) : (
                  completadas.map((c) => {
                    const sent = c.sent_count ?? c.recipient_ids?.length ?? 0;
                    const noCount = c.btn2_count ?? 0;
                    return (
                      <div key={c.id} style={{ background: '#F8F8F8', borderRadius: '12px', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
                          <div>
                            <p style={{ fontSize: '14px', fontWeight: 800, color: '#000', margin: 0 }}>{c.name}</p>
                            <p style={{ fontSize: '12px', color: '#999', margin: '3px 0 0 0' }}>
                              {new Date(c.created_at).toLocaleDateString('es-AR')}
                              {c.template_name && <> · <code>{c.template_name}</code></>}
                            </p>
                          </div>
                          {noCount > 0 && (
                            <button
                              onClick={() => handleDeleteNo(c)}
                              disabled={deletingNo === c.id}
                              style={{ background: 'transparent', color: '#E53935', fontWeight: 700, fontSize: '12px', border: '1px solid #f08080', borderRadius: '10px', padding: '7px 12px', cursor: deletingNo === c.id ? 'not-allowed' : 'pointer', opacity: deletingNo === c.id ? 0.6 : 1, whiteSpace: 'nowrap' }}
                            >
                              {deletingNo === c.id ? 'Eliminando…' : `🗑 Eliminar los que dijeron No (${noCount})`}
                            </button>
                          )}
                        </div>
                        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                          <Chip label="enviados"   value={sent}                color="#555"    bg="#ececec" />
                          <Chip label="entregados" value={c.delivered_count ?? 0} color="#1565c0" bg="#e3f0ff" />
                          <Chip label="leídos"     value={c.read_count ?? 0}    color="#1a7a3a" bg="#e8fff0" />
                          <Chip label="btn1"       value={c.btn1_count ?? 0}    color="#5b7a00" bg="#f4ffd1" />
                          <Chip label="btn2"       value={c.btn2_count ?? 0}    color="#b8860b" bg="#fff4d6" />
                          <Chip label="fallidos"   value={c.failed_count ?? 0}  color="#c0392b" bg="#ffe6e6" />
                        </div>
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
