"use client";

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { TemplateStatusDot } from '@/components/ui/TemplateStatusDot';
import { InfoCategorias } from '@/components/ui/InfoCategorias';
import { templateStatus } from '@/lib/template-status';
import { motivoDeFallo } from '@/lib/meta-error';

type Campaign = {
  id: string;
  name: string;
  type: 'texto_libre' | 'template_meta';
  template_name: string | null;
  template_language: string | null;
  template_variables: string[] | null;
  target_filter: string;
  target_number_id: string | null;
  // Filtro de destinatarios LEGACY (antes de separar emisor y filtro).
  target_number_ids: string[] | null;
  // Alcance por línea de los destinatarios. null = 'lineas' (default).
  target_scope: string | null;
  // Línea(s) EMISORA(s): desde qué número sale la campaña. null/vacío = modo
  // habitual (cada contacto recibe por su propia línea), que es el comportamiento
  // de todas las campañas anteriores a este cambio.
  sender_number_ids: string[] | null;
  status: 'borrador' | 'enviando' | 'completada' | 'pausada' | 'cancelada';
  sent_count: number;
  created_at: string;
  daily_cap: number | null;
  paused_reason: string | null;
  window_start_min: number | null;
  window_end_min: number | null;
  ramp_schedule: number[] | null;
  ramp_anchor: string | null;
  ramp_used_today?: number | null; // enviados hoy (día AR) de esta campaña; lo calcula el GET solo para ramped activas
  recipient_ids: string[] | null;
  exclude_campaign_ids: string[] | null;
  // Config de ritmo (para precargar el wizard al editar/relanzar). Vienen del select('*').
  interval_min_sec: number | null;
  interval_max_sec: number | null;
  pause_every: number | null;
  pause_seconds: number | null;
  send_limit: number | null;
  delivered_count: number | null;
  read_count: number | null;
  failed_count: number | null;
  btn1_count: number | null;
  btn2_count: number | null;
  // Desglose de motivos de fallo (lo calcula el GET agrupando campaign_message_status
  // por código de error de Meta). Se muestra traducido con motivoDeFallo. Ausente si
  // la campaña no tuvo fallos.
  failure_reasons?: { code: number | null; count: number; title: string | null; message: string | null }[];
};

// waba_id: cuenta de WhatsApp Business a la que pertenece la línea. Sin ella no
// hay plantillas asociadas, así que la línea no se puede usar en una campaña.
type WaLine = { id: string; label: string | null; active: boolean; is_default: boolean; waba_id: string | null };

// Plantilla guardada en Iris (tabla whatsapp_templates), con sus botones.
// waba_id null = legacy: se muestra para cualquier línea (no sabemos de qué WABA es).
// approval_status = estado en Meta; solo las aprobadas (o legacy sin estado) se eligen.
type IrisTemplate = {
  id: string; name: string; language: string; body: string; buttons: string[];
  waba_id: string | null; approval_status: string | null;
  // Para distinguir legacy (pre-migración de WABA, usable sin estado) de una
  // plantilla nueva que todavía no sincronizó su aprobación (bloqueada).
  created_at: string;
};

// Contacto seleccionable en el modo "elegir contactos" (agendados con usuario).
type PickContact = { id: string; name: string | null; phone: string; casino_username: string | null };

// Paginación del picker individual: filas por página del endpoint paginado
// (mismo patrón que la pantalla de Contactos). Acota egress/memoria en tenants
// grandes; para los chicos, 1 página los cubre casi entera y "Cargar más" ni aparece.
const PICKER_PAGE_SIZE = 100;

// Ventana horaria: 'HH:MM' ⇄ minutos desde medianoche.
function hhmmToMin(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]), mm = Number(m[2]);
  if (h > 23 || mm > 59) return null;
  return h * 60 + mm;
}
// Para el campo "Mandar hasta": 00:00 se interpreta como FIN del día (medianoche =
// 1440), no como el minuto 0. Un input type=time no permite elegir "24:00", así que
// 00:00 es la única forma de expresar "hasta medianoche". El backend ya acepta 1440
// (windowCols: e ≤ 1440) y withinWindow corta justo a las 00:00 del día siguiente.
function hhmmToEndMin(s: string): number | null {
  const min = hhmmToMin(s);
  return min === 0 ? 1440 : min;
}
function minToHHMM(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

// ── Cronograma escalonado (ramp-up) — utilidades de fecha (navegador en hora AR) ──
function atMidnight(d: Date): Date { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function addDays(d: Date, n: number): Date { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
// Lunes de la semana calendario (lun–dom) que contiene `d`.
function mondayOf(d: Date): Date {
  const x = atMidnight(d);
  const isoDow = x.getDay() === 0 ? 7 : x.getDay();   // 1=lun..7=dom
  return addDays(x, -(isoDow - 1));
}
function fmtDayMonth(d: Date): string {
  return d.toLocaleDateString('es-AR', { day: '2-digit', month: 'short' });
}
// Semana del cronograma que contiene `d` (0 = semana del ancla). Clamp lo hace quien llama.
function weekIndexOf(anchor: Date, d: Date): number {
  return Math.max(0, Math.floor((mondayOf(d).getTime() - anchor.getTime()) / (7 * 86_400_000)));
}
// Estimación de fecha de fin: simula día a día restando el límite del escalón vigente
// (clampeado al último). Ignora horario/techo de Meta → es un piso optimista.
function estimateFinish(total: number, weeks: number[], anchor: Date, today: Date): string | null {
  if (!total || total <= 0 || weeks.length === 0) return null;
  let remaining = total, day = new Date(today), guard = 0;
  while (remaining > 0 && guard < 3650) {
    const lim = weeks[Math.min(weekIndexOf(anchor, day), weeks.length - 1)] || 1;
    remaining -= lim;
    if (remaining > 0) day = addDays(day, 1);
    guard++;
  }
  return fmtDayMonth(day);
}
// Semana/límite vigente HOY de una campaña ya lanzada (para el indicador de la card).
function currentRampInfo(c: Campaign): { week: number; limit: number } | null {
  if (!Array.isArray(c.ramp_schedule) || c.ramp_schedule.length === 0 || !c.ramp_anchor) return null;
  const anchor = mondayOf(new Date(c.ramp_anchor + 'T00:00:00'));
  const wIdx = weekIndexOf(anchor, new Date());
  return { week: wIdx + 1, limit: c.ramp_schedule[Math.min(wIdx, c.ramp_schedule.length - 1)] };
}

// Cuenta cuántos placeholders {{1}}, {{2}}... distintos tiene el body.
function countTemplateVars(body: string): number {
  const matches = body.match(/\{\{\s*(\d+)\s*\}\}/g);
  if (!matches) return 0;
  const nums = matches.map((m) => Number(m.replace(/[^\d]/g, '')));
  return Math.max(0, ...nums);
}

// Los destinatarios se eligen con DOS dimensiones independientes, que se
// combinan libremente (ej: alcance "toda la base" + categoría "Inactivo" =
// todos los inactivos, sin importar su línea).
//
// 1) CATEGORÍA: por estado del contacto.
const FILTERS = [
  { value: 'todos',          label: 'Todos los contactos' },
  { value: 'cliente_activo', label: 'Cliente activo' },
  { value: 'inactivo',       label: 'Inactivo' },
  { value: 'inactivo_dias',  label: 'Inactivo sin recargar X días' },
  { value: 'nuevo',          label: 'Nuevo' },
];

// 2) ALCANCE: por línea. 'lineas' es el default y el comportamiento histórico.
const SCOPES = [
  { value: 'lineas', label: 'Líneas emisoras + contactos sin línea',
    hint: 'Los contactos de la(s) línea(s) elegida(s) en el paso 1, más los que nunca hablaron con ninguna línea.' },
  { value: 'suelto', label: 'Solo contactos sin línea',
    hint: 'Únicamente los que nunca hablaron con ninguna línea (típicamente, los importados).' },
  { value: 'libre',  label: 'Toda la base (ignorar líneas)',
    hint: 'Todos los contactos de la cuenta, sin importar por qué línea entraron.' },
] as const;

type Scope = typeof SCOPES[number]['value'];

// 'inactivo_dias' es un sentinel de UI: el filtro real es inactivo_Xd.
function effectiveFilter(f: string, days: number): string {
  return f === 'inactivo_dias' ? `inactivo_${days}d` : f;
}

// Query string de alcance para /api/contacts. Es la MISMA regla que aplica
// send-core al enviar, así que el "~N contactos" del asistente coincide con lo
// que realmente sale.
function scopeParams(scope: Scope, senderIds: string[]): string {
  if (scope === 'libre')  return '&scope=libre';
  if (scope === 'suelto') return '&scope=suelto';
  if (senderIds.length === 0) return '';   // emisor habitual: sin recorte por línea
  return `&scope=lineas&numbers=${senderIds.join(',')}`;
}

function filterLabel(value: string | null | undefined): string {
  // Null-safe: una campaña con target_filter null/'' no debe romper TODA la lista
  // (antes value.match(null) tiraba un TypeError que volteaba la pantalla entera).
  if (!value) return 'Todos los contactos';
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

// La línea va PRIMERO: las plantillas viven en la WABA de la línea, así que hasta
// no saber por dónde sale la campaña no se puede mostrar qué plantillas hay.
const STEPS = ['Línea emisora', 'Plantilla', 'Destinatarios', 'Configuración', 'Confirmar'];
const LAST_STEP = STEPS.length;

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

// Desglose de POR QUÉ fallaron los envíos de una campaña, traducido al castellano
// (el GET agrupa campaign_message_status por código de error de Meta). Se muestra
// tanto en la tarjeta de la campaña activa/pausada —donde más importa: para ver por
// qué está fallando MIENTRAS corre— como en el historial. Null si no hubo fallos.
function FailureReasons({ reasons }: { reasons?: Campaign['failure_reasons'] }) {
  if (!Array.isArray(reasons) || reasons.length === 0) return null;
  return (
    <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <span style={{ fontSize: '11px', fontWeight: 700, color: '#c0392b', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        Por qué fallaron
      </span>
      {reasons.map((fr, i) => (
        <div key={i} style={{ fontSize: '12px', color: '#7a2018', background: '#fff2f0', border: '1px solid #ffd6cf', borderRadius: '8px', padding: '6px 10px', display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
          <span style={{ fontWeight: 800, flexShrink: 0 }}>{fr.count}×</span>
          <span>
            {motivoDeFallo(fr.code, fr.title, fr.message)
              ?? `Meta rechazó el envío${fr.code != null ? ` (código ${fr.code})` : ''}.`}
          </span>
        </div>
      ))}
    </div>
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
  // Alcance por línea, independiente de la categoría de arriba.
  const [scope,        setScope]        = useState<Scope>('lineas');
  // ── Paso 1: línea EMISORA ───────────────────────────────────────────────────
  // Desde qué número sale la campaña, independiente de a qué línea estaba
  // asignado cada contacto.
  //   'habitual' = cada contacto recibe por SU línea de siempre (el
  //                comportamiento anterior a este cambio; es el default para que
  //                quien no toque nada obtenga exactamente lo de antes).
  //   'elegidas' = una o varias líneas, siempre de la misma WABA (las plantillas
  //                viven en la WABA).
  const [senderMode,    setSenderMode]    = useState<'habitual' | 'elegidas'>('habitual');
  const [senderLineIds, setSenderLineIds] = useState<string[]>([]);
  // Aviso al relanzar una campaña creada con el filtro por línea anterior: su
  // audiencia cambia al pasar al modelo nuevo. '' = sin aviso.
  const [avisoConversion, setAvisoConversion] = useState('');
  const [recipientCount, setRecipientCount] = useState<number | null>(null);
  const countSeqRef = useRef(0);   // descarta respuestas de conteo fuera de orden
  const [countLoading,   setCountLoading]   = useState(false);

  // Modo de destinatarios: por categoría (filtro) o selección individual (ids).
  const [targetMode,      setTargetMode]      = useState<'category' | 'individual'>('category');
  const [contactsList,    setContactsList]    = useState<PickContact[]>([]);
  const [contactsLoading, setContactsLoading] = useState(false);
  const [selectedIds,     setSelectedIds]     = useState<string[]>([]);
  const [contactSearch,   setContactSearch]   = useState('');
  // Paginación del picker (mismo patrón que Contactos). La selección (selectedIds)
  // es un array aparte, así que "Cargar más" NO pierde lo ya tildado.
  const [pickerHasMore,     setPickerHasMore]     = useState(false);
  const [pickerLoadingMore, setPickerLoadingMore] = useState(false);
  const pickerOffsetRef      = useRef(0);     // filas ya cargadas = próximo offset
  const pickerLoadingMoreRef = useRef(false); // guard doble click

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
  // Aviso de "hand-off al cron": la campaña era grande, se cortó por tiempo y sigue
  // enviándose sola en segundo plano (el navegador soltó el control).
  const [launchQueued, setLaunchQueued] = useState<{ sent: number; total: number } | null>(null);
  const [deletingNo,  setDeletingNo]  = useState<string | null>(null);

  // ── Techo diario de Meta (envío escalonado) ──────────────────────────────────
  // marginPct: % del límite real de Meta que se permite gastar (default 80). El
  // techo absoluto (daily_cap) = floor(metaLimit × marginPct/100), se manda al crear.
  // metaInfo: límite real leído de la Graph API + uso ya consumido en las últimas 24h.
  const [marginPct,   setMarginPct]   = useState(80);
  // Ventana horaria de envío (hora AR). Default 08:00–20:00. Fuera de ella la campaña
  // se pausa ('fuera_de_horario') y retoma sola al volver a entrar.
  const [windowFrom,  setWindowFrom]  = useState('08:00');
  const [windowTo,    setWindowTo]    = useState('20:00');
  // Cronograma escalonado (ramp-up). Off por defecto → comportamiento actual (techo
  // fijo). rampWeeks = límite diario por semana calendario; se combina con el techo
  // de Meta (límite efectivo del día = min). El ancla la fija el server al lanzar.
  const [rampEnabled, setRampEnabled] = useState(false);
  const [rampWeeks,   setRampWeeks]   = useState<number[]>([20, 20, 30, 50]);
  // Editar y relanzar (Pieza 3). editingId != null → el wizard está en modo edición
  // (reusa la misma fila vía PUT). pendingEdit guarda la campaña mientras cargan de
  // forma async la plantilla y el límite de Meta (los aplican los effects de abajo).
  const [editingId,   setEditingId]   = useState<string | null>(null);
  const [pendingEdit, setPendingEdit] = useState<Campaign | null>(null);
  const editTplApplied    = useRef(false); // plantilla ya reaplicada en modo edición
  const editMarginApplied = useRef(false); // marginPct ya derivado de daily_cap
  const [metaInfo,    setMetaInfo]    = useState<{ tier: string | null; metaLimit: number | null; usedToday: number } | null>(null);
  const [metaLoading, setMetaLoading] = useState(false);
  // Uso en vivo (destinatarios únicos del tenant en 24h) para el indicador "X/Y hoy"
  // mientras hay un envío en curso. Se pollea junto con la lista de campañas.
  const [usageToday,  setUsageToday]  = useState<number | null>(null);

  const [historyOpen,  setHistoryOpen]  = useState(true);
  const [historyRange, setHistoryRange] = useState('1m');

  // Activas = en vuelo o borrador. Las terminales (completada/cancelada) van al Historial.
  const activeCampaigns = campaigns.filter((c) => c.status !== 'completada' && c.status !== 'cancelada');

  // ── WABA de la campaña, derivada de las líneas elegidas ─────────────────────
  // Una línea sin waba_id no se puede usar: sin WABA no tiene plantillas asociadas.
  const activeLines     = lines.filter((l) => l.active);
  const selectableLines = activeLines.filter((l) => !!l.waba_id);
  const allWabas        = Array.from(new Set(selectableLines.map((l) => l.waba_id as string)));

  // WABA vigente de la campaña, que es la de la línea EMISORA. En modo habitual
  // cada contacto sale por su propia línea, así que solo hay una WABA definida
  // cuando el tenant tiene una sola; con dos, no se puede saber de antemano y se
  // muestran todas las plantillas (igual que antes de separar emisor y filtro).
  const selectedWaba: string | null = senderMode === 'habitual'
    ? (allWabas.length === 1 ? allWabas[0] : null)
    : (selectableLines.find((l) => senderLineIds.includes(l.id))?.waba_id ?? null);

  // Líneas emisoras que se mandan al backend. [] = modo habitual.
  const senderIds = senderMode === 'habitual' ? [] : senderLineIds;

  // Plantillas que corresponden a la WABA elegida. Las legacy (waba_id null) se
  // muestran siempre: no sabemos de qué WABA son y hoy se usan sin problema.
  const visibleTemplates = templates.filter(
    (t) => !t.waba_id || !selectedWaba || t.waba_id === selectedWaba,
  );

  async function fetchCampaigns() {
    try {
      // no-store: el poll debe ver siempre el estado fresco (evita cualquier respuesta
      // servida del caché HTTP del navegador → el listado se actualiza en vivo).
      const res = await fetch('/api/campaigns', { cache: 'no-store' });
      if (!res.ok) return;
      const list = await res.json();
      setCampaigns(Array.isArray(list) ? list : []);
    } catch {}
    // Uso del límite diario de Meta (destinatarios únicos en 24h). Se refresca SIEMPRE
    // para el dashboard fijo, no solo durante un envío. Query barata (count en DB).
    try {
      const u = await fetch('/api/campaigns/usage', { cache: 'no-store' });
      if (u.ok) { const d = await u.json(); setUsageToday(typeof d?.usedToday === 'number' ? d.usedToday : null); }
    } catch {}
  }

  // Lee el límite REAL de Meta para el tenant (1 llamada a la Graph API) + uso ya
  // consumido en 24h. Se usa en el paso Confirmar para proponer el techo por defecto.
  async function fetchMetaLimit() {
    setMetaLoading(true);
    try {
      const r = await fetch('/api/campaigns/limit');
      if (r.ok) setMetaInfo(await r.json());
    } catch {}
    setMetaLoading(false);
  }

  useEffect(() => {
    fetchCampaigns();
    fetchMetaLimit();   // límite real de Meta + tier para el dashboard fijo (1 llamada a la Graph API)
    fetch('/api/whatsapp-numbers')
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setLines(Array.isArray(d) ? d : []))
      .catch(() => {});
    const t = setInterval(fetchCampaigns, 10_000);
    return () => clearInterval(t);
  }, []);

  // Al abrir el asistente sincronizamos el estado de aprobación contra Meta (1
  // llamada a la Graph API por WABA) para no ofrecer plantillas que Meta todavía
  // no aprobó — se enviarían y fallarían en silencio (132001). Si el sync falla,
  // caemos al listado local de siempre.
  async function fetchTemplates() {
    setTplLoading(true); setTplError('');
    try {
      const synced = await fetch('/api/whatsapp-templates/sync', { method: 'POST' });
      if (synced.ok) {
        const d = await synced.json().catch(() => null);
        if (d && Array.isArray(d.templates)) {
          setTemplates(d.templates);
          setTplLoading(false); setTplLoaded(true);
          return;
        }
      }

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

  // Si cambian las líneas (y con ellas la WABA), la plantilla ya elegida puede
  // dejar de pertenecer a esa cuenta: la limpiamos para no arrastrar una que Meta
  // rechazaría en silencio. Solo corre con las plantillas ya cargadas, para no
  // pisar la precarga del modo edición (que las aplica de forma asíncrona).
  useEffect(() => {
    if (!showWizard || !tplLoaded || !templateName) return;
    // En modo edición no limpiamos: la plantilla la precarga otro effect de forma
    // asíncrona y, si `lines` llega después, este correría con el nombre ya puesto
    // y lo borraría. El backend igual revalida plantilla vs WABA al relanzar.
    if (pendingEdit) return;
    const sigueValida = templates.some(
      (t) => t.name === templateName
        && (!t.waba_id || !selectedWaba || t.waba_id === selectedWaba)
        && templateStatus(t.approval_status, t.created_at).usable,
    );
    if (!sigueValida) {
      setTemplateName(''); setTemplateBody(''); setTemplateButtons([]); setTemplateVars([]);
    }
    // Deliberadamente sin `templateName` en las deps: solo reaccionamos al cambio
    // de WABA, no a que el operador elija otra plantilla.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedWaba, tplLoaded, showWizard]);

  function selectTemplate(t: IrisTemplate) {
    setTemplateName(t.name);
    setTemplateLang(t.language || 'es');
    setTemplateBody(t.body || '');
    setTemplateButtons(Array.isArray(t.buttons) ? t.buttons : []);
    const count = countTemplateVars(t.body || '');
    setTemplateVars(count > 0 ? Array(count).fill('') : []);
    setError('');
  }

  // Conteo estimado de destinatarios: categoría (`f`) × alcance (`sc`) × líneas
  // emisoras (`lineIds`). Misma regla que el envío real, así que el "~N" coincide.
  async function fetchRecipientCount(f: string, lineIds: string[], sc: Scope) {
    // Solo la respuesta de la ÚLTIMA llamada pisa el contador: tildar varias
    // líneas rápido dispara varias y podrían llegar desordenadas, dejando en
    // pantalla un total que no corresponde a la selección actual.
    const seq = ++countSeqRef.current;
    setCountLoading(true); setRecipientCount(null);
    try {
      const isInactivoDays = /^inactivo_\d+d$/.test(f);
      const param = isInactivoDays ? `?status=inactivo` : f === 'todos' ? '?all=true' : `?status=${f}`;
      const res = await fetch(`/api/contacts${param}${scopeParams(sc, lineIds)}`);
      if (!res.ok || seq !== countSeqRef.current) return;
      const data = await res.json();
      if (seq !== countSeqRef.current) return;   // llegó tarde: la ganó otra llamada
      // El endpoint ahora devuelve { count } (conteo agregado en SQL). Fallback al
      // array por compatibilidad si algún deploy viejo respondiera la lista.
      setRecipientCount(
        typeof data?.count === 'number' ? data.count : Array.isArray(data) ? data.length : null,
      );
    } catch {}
    if (seq === countSeqRef.current) setCountLoading(false);
  }

  // Trae UNA página del listado paginado (server-side: orden + búsqueda + rango),
  // el mismo endpoint que la pantalla de Contactos (?limit=). Reemplaza la ruta
  // legacy que traía TODOS los agendados sin límite.
  // El picker ofrece el MISMO universo que va a recibir la campaña: contactos de
  // las líneas emisoras + los sueltos. Así el operador no puede elegir a mano a
  // alguien que después el envío descartaría. Vacío = modo habitual, sin recorte.
  const fetchContactsPage = useCallback(async (q: string, offset: number, lineIds: string[] = [], sc: Scope = 'lineas'): Promise<PickContact[] | null> => {
    const params = new URLSearchParams({ limit: String(PICKER_PAGE_SIZE), offset: String(offset), sort: 'az' });
    const term = q.trim();
    if (term) params.set('q', term);
    if (sc === 'libre' || sc === 'suelto') params.set('scope', sc);
    else if (lineIds.length > 0) { params.set('scope', 'lineas'); params.set('numbers', lineIds.join(',')); }
    try {
      const res = await fetch(`/api/contacts?${params.toString()}`);
      if (!res.ok) return null;
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    } catch { return null; }
  }, []);

  // Primera página (reset) con la búsqueda actual.
  const loadPickerFirst = useCallback(async (q: string, lineIds: string[] = [], sc: Scope = 'lineas') => {
    setContactsLoading(true);
    const rows = await fetchContactsPage(q, 0, lineIds, sc);
    setContactsList(rows ?? []);
    setPickerHasMore((rows?.length ?? 0) === PICKER_PAGE_SIZE);
    pickerOffsetRef.current = rows?.length ?? 0;
    setContactsLoading(false);
  }, [fetchContactsPage]);

  // "Cargar más": siguiente página; appendea (dedup por id). La selección persiste
  // (selectedIds es aparte), así que no se pierde nada de lo ya tildado.
  async function loadPickerMore() {
    if (pickerLoadingMoreRef.current || !pickerHasMore) return;
    pickerLoadingMoreRef.current = true; setPickerLoadingMore(true);
    const rows = await fetchContactsPage(contactSearch, pickerOffsetRef.current, senderIds, scope);
    if (rows) {
      pickerOffsetRef.current += rows.length;
      setContactsList((prev) => {
        const seen = new Set(prev.map((c) => c.id));
        return [...prev, ...rows.filter((r) => !seen.has(r.id))];
      });
      setPickerHasMore(rows.length === PICKER_PAGE_SIZE);
    }
    pickerLoadingMoreRef.current = false; setPickerLoadingMore(false);
  }

  // Al entrar a "individual" y ante cambios de búsqueda, recarga la primera página
  // (búsqueda server-side, debounced 300 ms; vacío/entrada = inmediato). En
  // "category" no hace nada.
  useEffect(() => {
    if (targetMode !== 'individual') return;
    const t = setTimeout(() => { loadPickerFirst(contactSearch, senderIds, scope); }, contactSearch ? 300 : 0);
    return () => clearTimeout(t);
  }, [targetMode, contactSearch, loadPickerFirst]);

  function handleTargetModeChange(mode: 'category' | 'individual') {
    setTargetMode(mode);
    setError('');
  }

  function toggleContact(id: string) {
    setSelectedIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  }

  function handleFilterChange(f: string) {
    setFilter(f);
    fetchRecipientCount(effectiveFilter(f, inactiveDays), senderIds, scope);
  }
  function handleScopeChange(sc: Scope) {
    setScope(sc);
    setError('');
    fetchRecipientCount(effectiveFilter(filter, inactiveDays), senderIds, sc);
    // El picker individual ofrece el mismo universo que el envío: si cambia el
    // alcance, la lista visible tiene que cambiar con él.
    if (targetMode === 'individual') loadPickerFirst(contactSearch, senderIds, sc);
  }

  function handleDaysChange(value: string) {
    const days = Math.min(365, Math.max(1, Number(value) || 1));
    setInactiveDays(days);
    if (filter === 'inactivo_dias') fetchRecipientCount(effectiveFilter('inactivo_dias', days), senderIds, scope);
  }

  // ── Paso 1: elección de líneas ──────────────────────────────────────────────
  // Tildar/destildar una línea. Solo se puede combinar con líneas de la MISMA
  // WABA: si la que se tilda es de otra, se bloquea con un aviso en vez de
  // dejar armar una campaña que Meta rechazaría a la mitad.
  function toggleLine(line: WaLine) {
    if (!line.waba_id) return;  // sin WABA no hay plantillas: no seleccionable

    const yaEstaba = senderLineIds.includes(line.id);
    if (!yaEstaba) {
      const wabaActual = selectableLines.find((l) => senderLineIds.includes(l.id))?.waba_id ?? null;
      if (wabaActual && wabaActual !== line.waba_id) {
        setError('Esa línea es de otra cuenta de WhatsApp (WABA). Una campaña solo puede usar líneas de una misma WABA: destildá las otras primero.');
        return;
      }
    }

    const proximas = yaEstaba
      ? senderLineIds.filter((x) => x !== line.id)
      : [...senderLineIds, line.id];

    setError('');
    setSenderLineIds(proximas);
    // El estimado de destinatarios depende de las líneas: hay que recalcularlo acá
    // (antes lo hacía el select de línea del paso Destinatarios, que ya no está).
    fetchRecipientCount(effectiveFilter(filter, inactiveDays), proximas, scope);
    if (targetMode === 'individual') loadPickerFirst(contactSearch, proximas, scope);
  }

  function handleSenderModeChange(mode: 'habitual' | 'elegidas') {
    setSenderMode(mode);
    setError('');
    // Al volver a 'habitual' se destildan las líneas: si no, quedarían guardadas y
    // reaparecerían tildadas al volver a 'elegidas' sin que el operador las elija.
    const proximas = mode === 'habitual' ? [] : senderLineIds;
    if (mode === 'habitual') setSenderLineIds([]);
    fetchRecipientCount(effectiveFilter(filter, inactiveDays), proximas, scope);
    // El picker individual muestra el mismo universo que el envío: si cambia el
    // alcance hay que recargarlo, o queda una lista que ya no se corresponde con
    // el "~N contactos" de al lado.
    if (targetMode === 'individual') loadPickerFirst(contactSearch, proximas, scope);
  }

  function resetWizard() {
    setStep(1); setName('');
    setTemplateName(''); setTemplateLang('es'); setTemplateBody(''); setTemplateButtons([]); setTemplateVars([]);
    setFilter('todos'); setInactiveDays(30); setRecipientCount(null); setScope('lineas');
    setSenderMode('habitual'); setSenderLineIds([]);
    setTargetMode('category'); setSelectedIds([]); setContactSearch('');
    setSendLimit(''); setIntervalMin('1'); setIntervalMax('3'); setPauseEvery(''); setPauseSeconds('');
    setExcludePrevious(false); setExcludeCampaignIds([]);
    setMarginPct(80);
    setWindowFrom('08:00'); setWindowTo('20:00');
    setRampEnabled(false); setRampWeeks([20, 20, 30, 50]);
    setAvisoConversion('');
    setEditingId(null); setPendingEdit(null);
    setError('');
    // Fuerza el re-fetch (con sync contra Meta) en CADA apertura del asistente.
    // Antes se cargaba una sola vez por sesión de página, y una plantilla creada
    // después quedaba en la lista vieja sin estado — gris y elegible (el bug de
    // revinculacion_2). resetWizard corre en las dos aperturas (nueva y edición).
    setTplLoaded(false);
  }

  function openWizard() {
    resetWizard(); setShowWizard(true); setLaunchResult(null); setLaunchQueued(null);
    fetchRecipientCount('todos', [], 'lineas');
    fetchMetaLimit();
  }
  function closeWizard() { resetWizard(); setShowWizard(false); }

  // ── Editar y relanzar (Pieza 3) ──────────────────────────────────────────────
  // Abre el wizard precargado con los datos de una campaña DETENIDA. Los campos
  // simples se setean acá; la plantilla (async: depende de que carguen) y el margen
  // (depende del límite de Meta) los aplican los effects de abajo vía pendingEdit.
  function openEditWizard(c: Campaign) {
    resetWizard();
    editTplApplied.current = false;
    editMarginApplied.current = false;
    setEditingId(c.id);
    setPendingEdit(c);
    setName(c.name);
    setTemplateLang(c.template_language ?? 'es');

    if (Array.isArray(c.recipient_ids) && c.recipient_ids.length > 0) {
      setTargetMode('individual');
      setSelectedIds(c.recipient_ids);
    } else {
      const m = (c.target_filter || '').match(/^inactivo_(\d+)d$/);
      if (m) { setFilter('inactivo_dias'); setInactiveDays(Number(m[1])); }
      else if (c.target_filter && c.target_filter !== 'seleccion') setFilter(c.target_filter);
    }

    // Línea emisora: la de la campaña si ya la tiene. Para las campañas anteriores
    // a este cambio se toma su filtro de línea legacy (target_number_id/ids) como
    // emisora: su universo eran justamente los contactos de esa línea, así que el
    // emisor resultante coincide con el de antes. Sin nada → modo habitual.
    const guardadas = Array.isArray(c.sender_number_ids) && c.sender_number_ids.length > 0
      ? c.sender_number_ids
      : (Array.isArray(c.target_number_ids) && c.target_number_ids.length > 0
          ? c.target_number_ids
          : (c.target_number_id ? [c.target_number_id] : []));

    // Saneo: una línea que desde entonces se desactivó o se quedó sin WABA no se
    // puede mostrar en el paso 1, y dejarla tildada trabaría el relanzamiento con
    // una selección invisible. Si `lines` todavía no cargó, se respeta lo guardado
    // tal cual (nunca ensanchamos la audiencia por una carrera de red).
    const savedLines = lines.length === 0
      ? guardadas
      : guardadas.filter((id) => selectableLines.some((l) => l.id === id));

    // Si la campaña tenía línea y el saneo la descartó (se desactivó o perdió la
    // WABA), NO caemos a 'habitual': eso sacaría toda restricción de línea y el
    // relanzamiento saldría a la base entera. Dejamos 'elegidas' sin nada tildado,
    // así stepBlocker(1) obliga a elegir emisora a mano.
    const emisoraDescartada = guardadas.length > 0 && savedLines.length === 0;
    setSenderMode(savedLines.length > 0 || emisoraDescartada ? 'elegidas' : 'habitual');
    setSenderLineIds(savedLines);

    // Aviso de conversión: la campaña usaba el filtro por línea viejo y al
    // relanzarla pasa al modelo nuevo (emisora + sueltos), que es un universo
    // más amplio. Que no cambie la audiencia por sorpresa.
    const eraLegacy = !(Array.isArray(c.sender_number_ids) && c.sender_number_ids.length > 0)
      && (Array.isArray(c.target_number_ids) ? c.target_number_ids.length > 0 : !!c.target_number_id);
    setAvisoConversion(
      emisoraDescartada
        ? 'La línea que usaba esta campaña ya no está disponible (inactiva o sin WABA). Elegí desde qué línea la relanzás.'
        : eraLegacy
          ? 'Esta campaña usaba el filtro por línea anterior. Al relanzarla pasa al modo nuevo: además de los contactos de esa línea se suman los que no tienen línea asignada. Revisá el total en el paso Destinatarios.'
          : '',
    );

    setIntervalMin(String(c.interval_min_sec ?? 1));
    setIntervalMax(String(c.interval_max_sec ?? 3));
    setPauseEvery(c.pause_every != null ? String(c.pause_every) : '');
    setPauseSeconds(c.pause_seconds != null ? String(c.pause_seconds) : '');
    setSendLimit(c.send_limit != null ? String(c.send_limit) : '');
    setExcludeCampaignIds(Array.isArray(c.exclude_campaign_ids) ? c.exclude_campaign_ids : []);
    setExcludePrevious(Array.isArray(c.exclude_campaign_ids) && c.exclude_campaign_ids.length > 0);

    if (c.window_start_min != null) setWindowFrom(minToHHMM(c.window_start_min));
    if (c.window_end_min != null) setWindowTo(c.window_end_min >= 1440 ? '00:00' : minToHHMM(c.window_end_min));

    if (Array.isArray(c.ramp_schedule) && c.ramp_schedule.length > 0) {
      setRampEnabled(true); setRampWeeks(c.ramp_schedule);
    }

    setShowWizard(true); setLaunchResult(null); setLaunchQueued(null);
    // Alcance guardado. Compat: en la versión anterior vivía dentro de
    // target_filter, así que una campaña de esa ventana se precarga bien.
    const scopeGuardado: Scope =
      c.target_scope === 'suelto' || c.target_scope === 'libre' || c.target_scope === 'lineas'
        ? c.target_scope
        : (c.target_filter === 'suelto' || c.target_filter === 'libre' ? c.target_filter : 'lineas');
    setScope(scopeGuardado);
    // Si la categoría venía ocupada por el alcance (modelo viejo), la reseteamos.
    if (c.target_filter === 'suelto' || c.target_filter === 'libre') setFilter('todos');

    fetchRecipientCount(
      c.target_filter === 'suelto' || c.target_filter === 'libre' ? 'todos' : (c.target_filter || 'todos'),
      savedLines,
      scopeGuardado,
    );
    fetchMetaLimit();
  }

  // Reaplica la plantilla al editar: espera a que carguen las plantillas, selecciona la
  // que matchea por nombre (trae body/botones) y restaura las variables guardadas.
  useEffect(() => {
    if (!pendingEdit || editTplApplied.current || templates.length === 0) return;
    const t = templates.find((x) => x.name === pendingEdit.template_name);
    if (t) {
      selectTemplate(t);
      const saved = Array.isArray(pendingEdit.template_variables) ? pendingEdit.template_variables : [];
      if (saved.length) setTemplateVars(saved);
    } else {
      setTemplateName(pendingEdit.template_name ?? ''); // no está: al menos preservamos el nombre
    }
    editTplApplied.current = true;
  }, [pendingEdit, templates]);

  // Deriva marginPct del daily_cap guardado, cuando ya se leyó el límite real de Meta.
  useEffect(() => {
    if (!pendingEdit || editMarginApplied.current) return;
    const lim = metaInfo?.metaLimit;
    if (lim == null) return;
    if (pendingEdit.daily_cap != null) {
      setMarginPct(Math.min(100, Math.max(10, Math.round((pendingEdit.daily_cap / lim) * 100))));
    }
    editMarginApplied.current = true;
  }, [pendingEdit, metaInfo]);

  // Qué le falta a un paso para estar completo ('' = está OK). Es la fuente única
  // de la validación del asistente: deshabilita "Siguiente", explica el motivo en
  // el propio paso y, al confirmar, impide lanzar una campaña a medio armar.
  function stepBlocker(s: number): string {
    if (s === 1) {
      // Modo habitual: no depende de que las líneas tengan WABA cargada (es el
      // camino que reproduce el comportamiento anterior). PERO con dos WABAs en
      // juego no se puede: cada contacto saldría por su línea y no hay una
      // plantilla que exista en las dos → Meta rechazaría media campaña en
      // silencio (132001). Ahí hay que elegir emisora sí o sí.
      if (senderMode === 'habitual') {
        return allWabas.length > 1
          ? 'Tus líneas son de WABAs distintas: no hay una plantilla que sirva para todas. Elegí desde qué línea sale la campaña.'
          : '';
      }
      if (lines.length > 0 && selectableLines.length === 0) {
        return 'Ninguna de tus líneas tiene cargada su cuenta de WhatsApp (WABA), así que no se puede elegir emisora. Usá "Cada contacto por su línea habitual", o pedile al admin que complete la WABA en Configuración → Números de WhatsApp.';
      }
      return senderLineIds.length === 0 ? 'Elegí al menos una línea emisora.' : '';
    }
    if (s === 2) {
      if (!name.trim()) return 'Poné un nombre a la campaña.';
      if (!templateName.trim()) return 'Elegí una plantilla.';
      return '';
    }
    if (s === 3) return targetMode === 'individual' && selectedIds.length === 0 ? 'Elegí al menos un contacto.' : '';
    if (s === 4) {
      const lo = Number(intervalMin), hi = Number(intervalMax);
      return (!isNaN(lo) && !isNaN(hi) && lo >= 0 && hi >= lo) ? '' : 'El intervalo mínimo no puede ser mayor que el máximo.';
    }
    return '';
  }

  function canAdvance(): boolean { return stepBlocker(step) === ''; }

  function next() {
    const blocker = stepBlocker(step);
    if (blocker) { setError(blocker); return; }
    setError(''); setStep((s) => Math.min(LAST_STEP, s + 1));
  }
  function back() { setError(''); setStep((s) => Math.max(1, s - 1)); }

  async function launch() {
    // Guard final: ningún paso puede quedar incompleto. Si alguno lo está, se
    // vuelve a ESE paso con el motivo, en vez de crear una campaña a medias.
    for (let s = 1; s < LAST_STEP; s++) {
      const blocker = stepBlocker(s);
      if (blocker) { setStep(s); setError(blocker); return; }
    }

    setLaunching(true); setError(''); setLaunchProgress('');
    try {
      const isIndividual = targetMode === 'individual';
      // Techo diario absoluto = % elegido × límite real de Meta. Si no pudimos leer
      // el límite (o es ilimitado), va null → sin tope (se envía como antes).
      const metaLimit = metaInfo?.metaLimit ?? null;
      const dailyCap = metaLimit != null ? Math.max(1, Math.floor((metaLimit * marginPct) / 100)) : null;
      // Ventana horaria: validamos mismo día (desde < hasta) antes de crear. El "hasta"
      // usa hhmmToEndMin: 00:00 = medianoche (1440), para poder mandar hasta fin del día.
      const winFromMin = hhmmToMin(windowFrom);
      const winToMin   = hhmmToEndMin(windowTo);
      if (winFromMin == null || winToMin == null || winFromMin >= winToMin) {
        setError('La ventana horaria no es válida: "Mandar desde" debe ser una hora menor que "Mandar hasta".');
        setLaunching(false);
        return;
      }
      const createBody = {
        name: name.trim(),
        target_filter: isIndividual ? 'seleccion' : effectiveFilter(filter, inactiveDays),
        // Alcance por línea, independiente de la categoría de arriba.
        target_scope: isIndividual ? null : scope,
        type: 'template_meta',
        template_name: templateName.trim(),
        template_language: templateLang.trim() || 'es',
        template_variables: templateVars.filter((v) => v.trim() !== ''),
        // En individual: sin límite/exclusión y sin filtro de línea (cada contacto
        // sale por su propio número). recipient_ids manda la lista elegida.
        send_limit: isIndividual ? null : (sendLimit ? Number(sendLimit) : null),
        // Línea(s) EMISORA(s) del paso 1 (todas de la misma WABA; el backend lo
        // revalida). Vacío = modo habitual. También van en modo individual: no
        // segmentan (manda recipient_ids), pero le dan al backend el contexto de
        // WABA para validar que la plantilla exista en esa cuenta.
        sender_number_ids: senderIds,
        // El filtro de destinatarios por línea quedó obsoleto: el alcance ahora lo
        // define la emisora. Se mandan vacíos para que al relanzar una campaña
        // vieja se limpie su filtro legacy en vez de arrastrarlo.
        target_number_ids: [],
        target_number_id:  null,
        exclude_campaign_ids: isIndividual ? [] : (excludePrevious ? excludeCampaignIds : []),
        recipient_ids: isIndividual ? selectedIds : [],
        interval_min_sec: Number(intervalMin) || 0,
        interval_max_sec: Number(intervalMax) || 0,
        pause_every:   pauseEvery ? Number(pauseEvery) : null,
        pause_seconds: pauseSeconds ? Number(pauseSeconds) : null,
        daily_cap:     dailyCap,
        window_start_min: winFromMin,
        window_end_min:   winToMin,
        // Cronograma escalonado: solo si está activado. El server fija el ancla (lunes AR).
        ramp_schedule: rampEnabled ? rampWeeks.filter((n) => Number.isFinite(n) && n >= 1) : null,
      };
      // Crear (POST) o, en modo edición, actualizar la MISMA fila (PUT) y relanzar.
      // En PUT el backend saltea a los ya enviados (filtro por campaign_recipients).
      const res = await fetch('/api/campaigns', {
        method: editingId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editingId ? { campaignId: editingId, ...createBody } : createBody),
      });
      if (!res.ok) throw new Error(await res.text());
      const campaign = await res.json();

      // Refetch inmediato: que la card (y el botón Detener) aparezca al toque en el
      // listado en vez de esperar al poll de 10s.
      fetchCampaigns();

      // Auto-resume: /send corta por presupuesto de tiempo en campañas grandes y
      // devuelve done:false; lo re-llamamos hasta done:true (saltea a los ya
      // intentados server-side). El guard es un backstop ante un bucle inesperado.
      let done = false, guard = 0, sentTotal = 0, total = 0, pausedByLimit = false, handedOff = false;
      while (!done) {
        if (++guard > 300) throw new Error('El envío no terminó tras muchos reintentos; revisá el estado de la campaña.');
        const sendRes = await fetch('/api/campaigns/send', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ campaignId: campaign.id }),
        });
        const data = await sendRes.json();
        if (!sendRes.ok) throw new Error(data?.error ?? 'Error al enviar la campaña.');
        sentTotal = data.sentTotal ?? data.sent ?? sentTotal;
        total     = data.total ?? total;
        if (data.cancelled) break;                                // el operador la detuvo: cortamos limpio
        // Cortada por tiempo: quedó 'pausada'/'auto_resume' y la sigue el cron. Soltamos
        // el control (no la manejamos en paralelo → evita doble envío) y avisamos.
        if (data.handedOff) { handedOff = true; break; }
        // Pausada por el techo diario de Meta u horario: NO reintentamos (el cron la
        // retoma sola). Cortamos el loop; el banner de la pantalla avisa.
        if (data.paused) { pausedByLimit = true; break; }
        done = data.done !== false;                               // sin done → compat: tratamos como terminado
        if (!done) setLaunchProgress(`Enviando ${data.attemptedTotal ?? sentTotal} / ${total}…`);
      }

      if (handedOff) setLaunchQueued({ sent: sentTotal, total });
      else setLaunchResult(pausedByLimit ? null : { sent: sentTotal, total });
      closeWizard();
      fetchCampaigns();
    } catch (e: any) {
      setError(e.message ?? 'Error al lanzar la campaña.');
    }
    setLaunching(false);
    setLaunchProgress('');
  }

  // Detener (cancelar) una campaña en curso o pausada: pasa a estado terminal
  // 'cancelada'. El cron ya no la retoma y, si había una tanda en vuelo, el backend
  // no la revive (guarda anti-carrera en runCampaignBatch). Conserva el progreso.
  async function handleStop(campaign: Campaign) {
    if (!confirm(`¿Detener la campaña "${campaign.name}"? No se enviarán más mensajes. Después vas a poder eliminarla o editarla y relanzarla.`)) return;
    try {
      await fetch('/api/campaigns', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ campaignId: campaign.id, status: 'cancelada' }),
      });
      fetchCampaigns();
    } catch {}
  }

  async function handleDelete(campaign: Campaign) {
    if (!confirm(`¿Eliminar la campaña "${campaign.name}"? Se borra el registro y sus estadísticas. Los mensajes ya enviados a los clientes no se tocan. No se puede deshacer.`)) return;
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

      {/* Dashboard del límite diario de Meta — siempre visible (haya o no envío corriendo).
          used = destinatarios únicos de campañas en la ventana móvil de 24h; metaLimit =
          techo real del WABA según el tier. */}
      {(() => {
        if (!metaInfo) return null; // esperamos la lectura del límite (evita flash de "ilimitado")
        const metaLimit = metaInfo.metaLimit ?? null;
        const used = usageToday ?? metaInfo.usedToday ?? 0;

        const nota = (
          <p style={{ fontSize: '11px', color: '#aaa', margin: 0, lineHeight: 1.5 }}>
            ~ Piso conservador: cuenta destinatarios únicos de <strong>campañas</strong> en 24h. El número real de Meta puede ser algo mayor si hubo envíos de plantilla fuera de campañas.
          </p>
        );

        // Sin límite legible (cuenta ilimitada o no se pudo leer): solo el conteo.
        if (metaLimit == null) {
          return (
            <div style={{ background: '#fff', borderRadius: '16px', padding: '16px 22px', boxShadow: '0 2px 12px rgba(0,0,0,0.08)', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                <span style={labelStyle}>Límite diario de Meta</span>
                <span style={{ fontSize: '11px', color: '#888' }}>{metaInfo?.tier ? `${metaInfo.tier} · ` : ''}ilimitado / no disponible</span>
              </div>
              <p style={{ fontSize: '14px', color: '#333', margin: 0, fontWeight: 600 }}>
                Usados en las últimas 24h: <strong>{(used ?? 0).toLocaleString('es-AR')}</strong> destinatarios.
              </p>
              {nota}
            </div>
          );
        }

        const u = used ?? 0;
        const pct = Math.min(100, Math.round((u / metaLimit) * 100));
        const remaining = Math.max(0, metaLimit - u);
        const color = pct >= 90 ? '#c0392b' : pct >= 70 ? '#c47a00' : '#1a7a3a';
        const barColor = pct >= 90 ? '#E53935' : pct >= 70 ? '#f0a020' : '#5ad87a';
        const alerta = pct >= 90;
        return (
          <div style={{ background: alerta ? '#fff5f5' : '#fff', borderRadius: '16px', padding: '16px 22px', boxShadow: '0 2px 12px rgba(0,0,0,0.08)', border: alerta ? '1px solid #f0a0a0' : '1px solid transparent', display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
              <span style={labelStyle}>Límite diario de Meta</span>
              <span style={{ fontSize: '11px', color: '#888' }}>{metaInfo?.tier ? `${metaInfo.tier} · ` : ''}{metaLimit.toLocaleString('es-AR')}/día</span>
            </div>
            <div style={{ height: '10px', background: '#eee', borderRadius: '999px', overflow: 'hidden' }}>
              <div style={{ width: `${pct}%`, height: '100%', background: barColor, borderRadius: '999px', transition: 'width 0.3s ease' }} />
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '18px', fontWeight: 900, color }}>{u.toLocaleString('es-AR')} / {metaLimit.toLocaleString('es-AR')}</span>
              <span style={{ fontSize: '12px', color: '#888' }}>(~{pct}%) · quedan ~{remaining.toLocaleString('es-AR')} en las próximas 24h</span>
            </div>
            {alerta && (
              <p style={{ fontSize: '12px', color: '#c0392b', fontWeight: 700, margin: 0, lineHeight: 1.5 }}>
                ⚠️ Cerca del límite diario de Meta — esperá a que se libere cupo antes de lanzar una campaña grande.
              </p>
            )}
            {nota}
          </div>
        );
      })()}

      {launchResult && (
        <div style={{ background: '#e8fff0', border: '1px solid #5ad87a', borderRadius: '12px', padding: '12px 16px' }}>
          <p style={{ fontSize: '13px', color: '#1a7a3a', fontWeight: 700, margin: 0 }}>
            ✅ Campaña lanzada: enviada a {launchResult.sent} de {launchResult.total} contactos.
          </p>
        </div>
      )}

      {launchQueued && (
        <div style={{ background: '#eef3ff', border: '1px solid #a9c0f0', borderRadius: '12px', padding: '12px 16px' }}>
          <p style={{ fontSize: '13px', color: '#3a5bb8', fontWeight: 700, margin: 0, lineHeight: 1.5 }}>
            📨 La campaña es grande: se enviaron {launchQueued.sent} de {launchQueued.total} y el resto sigue saliendo solo en segundo plano. Se completa automáticamente — no hace falta que dejes esta pantalla abierta.
          </p>
        </div>
      )}

      {/* Banners de pausa (estado en la base → visibles tras el poll de 10s aunque se
          haya cerrado la pestaña y reabierto). Uno por motivo. */}
      {(() => {
        const byLimit = activeCampaigns.filter((c) => c.status === 'pausada' && c.paused_reason === 'daily_limit');
        const byHours = activeCampaigns.filter((c) => c.status === 'pausada' && c.paused_reason === 'fuera_de_horario');
        const byRamp  = activeCampaigns.filter((c) => c.status === 'pausada' && c.paused_reason === 'cupo_diario');
        if (byLimit.length === 0 && byHours.length === 0 && byRamp.length === 0) return null;
        const banner: React.CSSProperties = { background: '#fff8e6', border: '1px solid #f0c040', borderRadius: '12px', padding: '12px 16px', display: 'flex', alignItems: 'center', gap: '10px' };
        const txt: React.CSSProperties = { fontSize: '13px', color: '#7a5c00', fontWeight: 700, margin: 0, lineHeight: 1.5 };
        return (
          <>
            {byRamp.length > 0 && (
              <div style={banner}>
                <span style={{ fontSize: '18px', flexShrink: 0 }}>📆</span>
                <p style={txt}>
                  {byRamp.length === 1
                    ? `Campaña pausada: alcanzó su límite diario del cronograma${(() => { const r = currentRampInfo(byRamp[0]); return r ? ` (${r.limit}/día, semana ${r.week})` : ''; })()}. Retoma automáticamente mañana.`
                    : `${byRamp.length} campañas pausadas por su límite diario del cronograma. Retoman automáticamente mañana.`}
                </p>
              </div>
            )}
            {byLimit.length > 0 && (
              <div style={banner}>
                <span style={{ fontSize: '18px', flexShrink: 0 }}>⏸️</span>
                <p style={txt}>
                  {byLimit.length === 1
                    ? `Campaña pausada: se alcanzó el límite diario de Meta. Retoma automáticamente mañana cuando se libere cupo.`
                    : `${byLimit.length} campañas pausadas: límite diario de Meta alcanzado. Retoman automáticamente al liberarse cupo.`}
                </p>
              </div>
            )}
            {byHours.length > 0 && (
              <div style={banner}>
                <span style={{ fontSize: '18px', flexShrink: 0 }}>🕒</span>
                <p style={txt}>
                  {byHours.length === 1
                    ? `Campaña pausada: fuera del horario configurado${byHours[0].window_start_min != null ? ` — retoma a las ${minToHHMM(byHours[0].window_start_min)}` : ''}.`
                    : `${byHours.length} campañas pausadas por horario. Retoman automáticamente al volver a su ventana de envío.`}
                </p>
              </div>
            )}
          </>
        );
      })()}

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

          {editingId && (
            <div style={{ background: '#eef6ee', border: '1px solid #cde8cd', borderRadius: '10px', padding: '10px 14px' }}>
              <p style={{ fontSize: '12px', color: '#1a7a3a', fontWeight: 600, margin: 0, lineHeight: 1.5 }}>
                ✏️ Estás editando una campaña detenida. Al relanzar, a quienes ya recibieron el mensaje NO se les reenvía; solo salen los pendientes y los que agregues.
              </p>
            </div>
          )}

          {/* ── PASO 1: Línea emisora ──
              Va antes que la plantilla porque las plantillas viven en la WABA de
              la línea: recién sabiendo por dónde sale la campaña se puede mostrar
              qué plantillas existen (y cuáles Meta aprobó). */}
          {step === 1 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {avisoConversion && (
                <p style={{ fontSize: '12px', color: '#8a6d1f', background: '#FFFBEA', border: '1px solid #FCE8A6', borderRadius: '10px', padding: '10px 14px', margin: 0, lineHeight: 1.5 }}>
                  ⚠ {avisoConversion}
                </p>
              )}
              <label style={labelStyle}>¿Desde qué número sale la campaña?</label>

              <div style={{ display: 'flex', gap: '6px' }}>
                {([['habitual', 'Cada contacto por su línea habitual'], ['elegidas', 'Elegir línea emisora']] as const).map(([mode, lbl]) => {
                  return (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => handleSenderModeChange(mode)}
                      style={{
                        flex: 1, padding: '9px 12px', fontSize: '13px', fontWeight: 700, cursor: 'pointer',
                        borderRadius: '10px', border: senderMode === mode ? '2px solid #1a7a3a' : '2px solid #e0e0e0',
                        background: senderMode === mode ? '#f0fff4' : '#fff', color: senderMode === mode ? '#1a7a3a' : '#888',
                      }}
                    >
                      {lbl}
                    </button>
                  );
                })}
              </div>

              {senderMode === 'habitual' && (
                <p style={{ fontSize: '12px', color: '#777', margin: 0, lineHeight: 1.5 }}>
                  Cada contacto recibe por el número con el que viene hablando. Es el comportamiento de siempre.
                </p>
              )}

              {senderMode === 'elegidas' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {lines.length === 0 && (
                    <p style={{ fontSize: '13px', color: '#888', margin: 0 }}>No hay líneas cargadas en esta cuenta.</p>
                  )}
                  {lines.filter((l) => l.active).map((l) => {
                    const checked  = senderLineIds.includes(l.id);
                    // Sin WABA no hay plantillas asociadas → no se puede elegir.
                    // Y si ya hay líneas tildadas, solo se suman las de esa misma WABA.
                    const sinWaba  = !l.waba_id;
                    const otraWaba = !!selectedWaba && !!l.waba_id && l.waba_id !== selectedWaba;
                    const disabled = sinWaba || (otraWaba && !checked);
                    return (
                      <label
                        key={l.id}
                        title={sinWaba ? 'Esta línea no tiene cargada su cuenta de WhatsApp (WABA), así que no tiene plantillas asociadas.'
                             : otraWaba ? 'Es de otra WABA: una campaña solo puede usar líneas de una misma WABA.' : undefined}
                        style={{
                          display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 14px',
                          borderRadius: '10px', border: checked ? '2px solid #1a7a3a' : '2px solid #e0e0e0',
                          background: checked ? '#f0fff4' : disabled ? '#FAFAFA' : '#fff',
                          cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={disabled}
                          onChange={() => toggleLine(l)}
                          style={{ cursor: disabled ? 'not-allowed' : 'pointer' }}
                        />
                        <span style={{ fontSize: '13px', fontWeight: 700, color: '#1a1a1a' }}>
                          {l.label ?? l.id}{l.is_default ? ' (default)' : ''}
                        </span>
                        {sinWaba
                          ? <span style={{ fontSize: '11px', color: '#E53935', fontWeight: 700 }}>sin WABA</span>
                          : allWabas.length > 1 && <span style={{ fontSize: '11px', color: '#aaa' }}>WABA …{String(l.waba_id).slice(-4)}</span>}
                      </label>
                    );
                  })}

                  {/* La regla de asignación, explícita: el operador no tiene por
                      qué adivinar por cuál de las emisoras sale cada contacto. */}
                  {senderLineIds.length > 0 && (() => {
                    const nombre = (id: string) => lines.find((l) => l.id === id)?.label ?? id;
                    return (
                      <p style={{ fontSize: '12px', color: '#1a7a3a', background: '#f0fff4', border: '1px solid #cdeccd', borderRadius: '10px', padding: '9px 12px', margin: 0, lineHeight: 1.5 }}>
                        {senderLineIds.length === 1
                          ? <>Todos los mensajes salen por <strong>{nombre(senderLineIds[0])}</strong>.</>
                          : <>La campaña sale por estas {senderLineIds.length} líneas. A quien ya venga hablando por una de ellas se le escribe por esa misma; al resto le sale por <strong>{nombre(senderLineIds[0])}</strong>.</>}
                      </p>
                    );
                  })()}
                </div>
              )}

              {stepBlocker(1) && (
                <p style={{ fontSize: '12px', color: '#c0392b', fontWeight: 600, margin: 0, lineHeight: 1.5 }}>{stepBlocker(1)}</p>
              )}
            </div>
          )}

          {/* ── PASO 2: Plantilla ── */}
          {step === 2 && (
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
              {!tplLoading && !tplError && visibleTemplates.length === 0 && (
                <p style={{ fontSize: '13px', color: '#888', margin: 0 }}>
                  {templates.length === 0
                    ? 'No hay plantillas guardadas. Creá una en Configuración → Plantillas de WhatsApp.'
                    : 'Las líneas elegidas no tienen plantillas asociadas. Creá una para esa cuenta en Configuración → Plantillas de WhatsApp.'}
                </p>
              )}

              {!tplLoading && visibleTemplates.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {visibleTemplates.map((t) => {
                    const selected = templateName === t.name;
                    // Sin aprobación de Meta la plantilla no se puede mandar: se
                    // muestra con su punto pero no es clickeable.
                    const st       = templateStatus(t.approval_status, t.created_at);
                    const disabled = !st.usable;
                    return (
                      <button
                        key={t.id}
                        type="button"
                        disabled={disabled}
                        title={disabled ? st.label : undefined}
                        onClick={() => selectTemplate(t)}
                        style={{
                          textAlign: 'left', cursor: disabled ? 'not-allowed' : 'pointer', borderRadius: '12px', padding: '12px 14px',
                          border: selected ? '2px solid #1a7a3a' : '2px solid #e0e0e0',
                          background: selected ? '#f0fff4' : disabled ? '#FAFAFA' : '#fff',
                          opacity: disabled ? 0.6 : 1,
                          display: 'flex', flexDirection: 'column', gap: '6px',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                          <TemplateStatusDot status={t.approval_status} createdAt={t.created_at} />
                          <code style={{ fontSize: '13px', fontWeight: 800, color: '#000', background: '#F5F5F5', borderRadius: '6px', padding: '2px 8px' }}>{t.name}</code>
                          <span style={{ fontSize: '11px', color: '#888' }}>{t.language}</span>
                          {disabled && <span style={{ fontSize: '11px', color: '#F2994A', fontWeight: 800 }}>{st.label}</span>}
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

          {/* ── PASO 3: Destinatarios ── */}
          {step === 3 && (
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
                  {/* Dimensión 1: CATEGORÍA (estado del contacto). */}
                  <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: '6px' }}>
                    Categoría <InfoCategorias />
                  </label>
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

                  {/* Dimensión 2: ALCANCE (por línea). Independiente de la categoría:
                      se combinan, así "toda la base" + "Inactivo" da todos los inactivos. */}
                  <label style={{ ...labelStyle, marginTop: '8px' }}>Alcance</label>
                  <select value={scope} onChange={(e) => handleScopeChange(e.target.value as Scope)} style={{ ...inputStyle, cursor: 'pointer' }}>
                    {SCOPES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </select>
                  <p style={{ fontSize: '11px', color: '#bbb', margin: '2px 0 0 0', lineHeight: 1.5 }}>
                    {SCOPES.find((s) => s.value === scope)?.hint}
                    {scope === 'lineas' && senderIds.length === 0 && ' Como la campaña sale por la línea habitual de cada contacto, no hay recorte.'}
                  </p>

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
                // El server ya filtró (búsqueda), ordenó y paginó: `visible` = lo cargado.
                const visible = contactsList;
                const visibleIds = visible.map((c) => c.id);
                const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.includes(id));
                const searching = contactSearch.trim().length > 0;
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
                    ) : visible.length === 0 ? (
                      <p style={{ fontSize: '13px', color: '#888', margin: 0 }}>
                        {searching ? `Sin resultados para “${contactSearch}”.` : 'No hay contactos agendados (con usuario) para elegir.'}
                      </p>
                    ) : (
                      <>
                        <div style={{ maxHeight: '320px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px', border: '1px solid #eee', borderRadius: '10px', padding: '6px' }}>
                          {visible.map((c) => {
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
                        {pickerHasMore && (
                          <button
                            type="button"
                            onClick={loadPickerMore}
                            disabled={pickerLoadingMore}
                            style={{ background: '#fff', color: '#1a1a1a', fontWeight: 700, fontSize: '13px', border: '1px solid #ddd', borderRadius: '10px', padding: '9px', cursor: pickerLoadingMore ? 'default' : 'pointer', opacity: pickerLoadingMore ? 0.6 : 1 }}
                          >
                            {pickerLoadingMore ? 'Cargando…' : 'Cargar más'}
                          </button>
                        )}
                      </>
                    )}
                  </div>
                );
              })()}
            </div>
          )}

          {/* ── PASO 4: Configuración ── */}
          {step === 4 && (
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

          {/* ── PASO 5: Confirmar ── */}
          {step === 5 && (
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
                {targetMode === 'category' && (
                  <div><strong>Alcance:</strong> {SCOPES.find((s) => s.value === scope)?.label}</div>
                )}
                <div>
                  <strong>Sale desde:</strong>{' '}
                  {senderIds.length === 0
                    ? 'la línea habitual de cada contacto'
                    : senderIds.map((id) => lines.find((l) => l.id === id)?.label ?? id).join(' · ')}
                </div>
                <div><strong>Ritmo:</strong> {intervalMin}–{intervalMax}s entre mensajes{pauseEvery && pauseSeconds ? ` · pausa de ${pauseSeconds}s cada ${pauseEvery}` : ''}</div>
                <div><strong>Horario:</strong> {windowFrom}–{windowTo === '00:00' ? 'medianoche' : windowTo} (hora AR)</div>
                {rampEnabled && <div><strong>Cronograma:</strong> {rampWeeks.map((n, i) => `S${i + 1} ${n}/día`).join(' · ')} (luego {rampWeeks[rampWeeks.length - 1]}/día)</div>}
                {targetMode === 'category' && sendLimit && <div><strong>Límite:</strong> {sendLimit} contactos</div>}
                {targetMode === 'category' && excludePrevious && excludeCampaignIds.length > 0 && <div><strong>Excluye:</strong> {excludeCampaignIds.length} campaña(s)</div>}
              </div>
              {/* ── Cronograma escalonado por semanas (ramp-up) ── */}
              <div style={{ background: '#F8F8F8', borderRadius: '12px', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <label style={{ fontSize: '13px', color: '#333', display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontWeight: 700 }}>
                  <input type="checkbox" checked={rampEnabled} onChange={(e) => setRampEnabled(e.target.checked)} />
                  Cronograma escalonado por semanas (ramp-up)
                </label>

                {!rampEnabled ? (
                  <p style={{ fontSize: '11px', color: '#888', margin: 0, lineHeight: 1.5 }}>
                    Activalo para subir el volumen de a poco (calentar el número): cada semana calendario (lun–dom) con su propio límite diario. Sin activar, se usa solo el techo de Meta de abajo.
                  </p>
                ) : (() => {
                  const total  = targetMode === 'individual' ? selectedIds.length : (recipientCount ?? 0);
                  const anchor = mondayOf(new Date());
                  const today  = atMidnight(new Date());
                  const last   = rampWeeks[rampWeeks.length - 1];
                  const est    = estimateFinish(total, rampWeeks, anchor, today);
                  return (
                    <>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                        {rampWeeks.map((lim, i) => {
                          // Semana 1 se muestra desde HOY (bloque parcial); las demás, lun–dom completas.
                          const start = i === 0 ? today : addDays(anchor, 7 * i);
                          const end   = addDays(anchor, 7 * i + 6);
                          return (
                            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                              <span style={{ fontSize: '12px', color: '#555', flex: 1, minWidth: 0 }}>
                                <strong>Semana {i + 1}</strong>{' '}
                                <span style={{ color: '#999' }}>({fmtDayMonth(start)} – {fmtDayMonth(end)})</span>
                              </span>
                              <input
                                type="number" min={1} value={lim}
                                onChange={(e) => setRampWeeks((w) => w.map((v, j) => j === i ? Math.max(1, Math.floor(Number(e.target.value)) || 1) : v))}
                                style={{ ...inputStyle, width: '74px', textAlign: 'center', padding: '8px 10px' }}
                              />
                              <span style={{ fontSize: '11px', color: '#888', width: '30px' }}>/día</span>
                              {rampWeeks.length > 1 && (
                                <button
                                  type="button"
                                  onClick={() => setRampWeeks((w) => w.filter((_, j) => j !== i))}
                                  title="Quitar semana"
                                  style={{ background: 'none', border: 'none', color: '#E53935', fontWeight: 800, fontSize: '18px', cursor: 'pointer', lineHeight: 1, flexShrink: 0 }}
                                >×</button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                      <button
                        type="button"
                        onClick={() => setRampWeeks((w) => [...w, w[w.length - 1] ?? 20])}
                        style={{ alignSelf: 'flex-start', background: '#fff', border: '1px solid #ddd', borderRadius: '8px', padding: '6px 12px', fontSize: '12px', fontWeight: 700, color: '#333', cursor: 'pointer' }}
                      >
                        + Agregar semana
                      </button>
                      <p style={{ fontSize: '11px', color: '#888', margin: 0, lineHeight: 1.5 }}>
                        La semana 1 arranca hoy ({fmtDayMonth(today)}); ese bloque parcial usa <strong>{rampWeeks[0]}/día</strong>. Al terminar la semana {rampWeeks.length} sigue a <strong>{last}/día</strong> hasta completar {total > 0 ? `los ${total.toLocaleString('es-AR')} contactos` : 'la campaña'}.{est ? <> Estimado de fin: <strong>~{est}</strong>.</> : null}
                      </p>
                      <p style={{ fontSize: '11px', color: '#888', margin: 0, lineHeight: 1.5 }}>
                        El horario de envío y el techo de Meta (abajo) se respetan igual: el límite de cada día es el menor entre el del cronograma y el de Meta.
                      </p>
                    </>
                  );
                })()}
              </div>

              {/* ── Techo diario de Meta (envío escalonado) ── */}
              {(() => {
                const metaLimit = metaInfo?.metaLimit ?? null;
                const usedHoy   = metaInfo?.usedToday ?? 0;
                const cap = metaLimit != null ? Math.max(1, Math.floor((metaLimit * marginPct) / 100)) : null;
                return (
                  <div style={{ background: '#F8F8F8', borderRadius: '12px', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                      <label style={labelStyle}>Techo diario de envío</label>
                      <span style={{ fontSize: '11px', color: '#888' }}>
                        {metaLoading ? 'Leyendo límite de Meta…'
                          : metaLimit != null ? `Límite Meta: ${metaLimit.toLocaleString('es-AR')}/día${metaInfo?.tier ? ` · ${metaInfo.tier}` : ''}`
                          : 'Límite de Meta no disponible'}
                      </span>
                    </div>

                    {metaLimit != null ? (
                      <>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
                          <input
                            type="range" min={10} max={100} step={5} value={marginPct}
                            onChange={(e) => setMarginPct(Number(e.target.value))}
                            style={{ flex: 1, accentColor: '#1a1a1a' }}
                          />
                          <span style={{ fontSize: '14px', fontWeight: 800, width: '46px', textAlign: 'right' }}>{marginPct}%</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' }}>
                          <span style={{ fontSize: '22px', fontWeight: 900, color: '#1a1a1a' }}>{cap!.toLocaleString('es-AR')}</span>
                          <span style={{ fontSize: '12px', color: '#888' }}>mensajes/día · {marginPct}% del límite real de Meta</span>
                        </div>
                        <p style={{ fontSize: '11px', color: '#888', margin: 0, lineHeight: 1.5 }}>
                          Ya enviados hoy (todas las líneas): <strong>{usedHoy.toLocaleString('es-AR')}</strong>.{' '}
                          {usedHoy >= cap!
                            ? 'Ya estás en el techo: la campaña arrancará pausada y retomará sola al liberarse cupo.'
                            : `Quedan ~${(cap! - usedHoy).toLocaleString('es-AR')} para hoy; al llegar al techo se pausa y retoma sola mañana.`}
                        </p>
                      </>
                    ) : (
                      <p style={{ fontSize: '12px', color: '#7a5c00', margin: 0, lineHeight: 1.5 }}>
                        {metaLoading ? 'Consultando el límite real de Meta…' : 'No se pudo leer el límite de Meta (o la cuenta es ilimitada). La campaña se enviará sin tope diario.'}
                      </p>
                    )}

                    {/* ── Ventana horaria de envío (hora AR) ── */}
                    <div style={{ borderTop: '1px solid #ececec', paddingTop: '12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      <label style={labelStyle}>Horario de envío (hora Argentina)</label>
                      <div style={{ display: 'flex', gap: '10px' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 1 }}>
                          <span style={{ fontSize: '11px', color: '#888' }}>Mandar desde</span>
                          <input type="time" value={windowFrom} onChange={(e) => setWindowFrom(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }} />
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 1 }}>
                          <span style={{ fontSize: '11px', color: '#888' }}>Mandar hasta</span>
                          <input type="time" value={windowTo} onChange={(e) => setWindowTo(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }} />
                        </div>
                      </div>
                      <span style={{ fontSize: '10px', color: '#aaa' }}>Para enviar hasta medianoche, elegí 00:00 como hora de fin.</span>
                      {(() => {
                        const f = hhmmToMin(windowFrom), t = hhmmToEndMin(windowTo);
                        if (f == null || t == null || f >= t) {
                          return <p style={{ fontSize: '11px', color: '#c0392b', margin: 0, fontWeight: 600 }}>&quot;Mandar desde&quot; tiene que ser una hora menor que &quot;Mandar hasta&quot; (mismo día).</p>;
                        }
                        const toLabel = windowTo === '00:00' ? 'medianoche (00:00)' : windowTo;
                        return <p style={{ fontSize: '11px', color: '#888', margin: 0, lineHeight: 1.5 }}>Solo se envía entre {windowFrom} y {toLabel}. Fuera de ese rango la campaña se pausa y retoma sola al volver al horario.</p>;
                      })()}
                    </div>
                  </div>
                );
              })()}

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
            {step < LAST_STEP ? (
              // Deshabilitado mientras el paso esté incompleto: el motivo se ve en
              // el propio paso (y en el tooltip), así no se avanza a ciegas.
              <button
                type="button"
                onClick={next}
                disabled={!canAdvance()}
                title={stepBlocker(step) || undefined}
                style={{
                  background: canAdvance() ? '#1a1a1a' : '#e0e0e0', color: canAdvance() ? '#C8FF00' : '#999',
                  fontWeight: 800, fontSize: '13px', border: 'none', borderRadius: '10px', padding: '10px 22px',
                  cursor: canAdvance() ? 'pointer' : 'not-allowed',
                }}
              >
                Siguiente →
              </button>
            ) : (
              <button type="button" onClick={launch} disabled={launching} style={{ background: launching ? '#e0e0e0' : '#C8FF00', color: '#000', fontWeight: 800, fontSize: '14px', border: 'none', borderRadius: '10px', padding: '10px 22px', cursor: launching ? 'not-allowed' : 'pointer', opacity: launching ? 0.6 : 1 }}>
                {launching ? (launchProgress || (editingId ? 'Relanzando…' : 'Lanzando…')) : (editingId ? '🔁 Relanzar campaña' : '🚀 Lanzar campaña')}
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
            {(() => {
              // 'auto_resume' es una continuación transitoria del cron: se muestra
              // como "en cola" (no como una pausa por límite, que es 'daily_limit').
              const isQueued = c.status === 'pausada' && c.paused_reason === 'auto_resume';
              const pill = c.status === 'enviando' ? { bg: '#fff8d6', fg: '#b8860b', label: c.status }
                : isQueued ? { bg: '#eef3ff', fg: '#3a5bb8', label: 'en cola' }
                : c.status === 'pausada' ? { bg: '#ffe9c7', fg: '#c47a00', label: c.status }
                : c.status === 'cancelada' ? { bg: '#f3d9d9', fg: '#a33a3a', label: 'detenida' }
                : { bg: '#F0F0F0', fg: '#888', label: c.status };
              return (
                <span style={{ background: pill.bg, color: pill.fg, fontSize: '11px', fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase', padding: '4px 12px', borderRadius: '20px', whiteSpace: 'nowrap' }}>
                  {pill.label}
                </span>
              );
            })()}
          </div>

          {/* Indicador de uso diario: solo con un envío EN CURSO (status enviando) y
              techo definido. "X/Y hoy" contra el techo de Meta del tenant. */}
          {c.status === 'enviando' && c.daily_cap != null && usageToday != null && (() => {
            const cap = c.daily_cap!;
            const pct = Math.min(100, Math.round((usageToday / cap) * 100));
            const full = usageToday >= cap;
            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                <div style={{ height: '10px', background: '#eee', borderRadius: '999px', overflow: 'hidden' }}>
                  <div style={{ width: `${pct}%`, height: '100%', background: full ? '#f0a020' : '#C8FF00', borderRadius: '999px', transition: 'width 0.3s ease' }} />
                </div>
                <p style={{ fontSize: '12px', color: '#666', margin: 0, fontWeight: 600 }}>
                  {usageToday.toLocaleString('es-AR')}/{cap.toLocaleString('es-AR')} hoy
                  <span style={{ color: '#aaa', fontWeight: 400 }}> · límite diario de Meta</span>
                </p>
              </div>
            );
          })()}

          {c.status === 'pausada' && c.paused_reason === 'daily_limit' && (
            <p style={{ fontSize: '12px', color: '#c47a00', margin: 0, fontWeight: 600 }}>
              ⏸️ Pausada por el límite diario de Meta · retoma automáticamente al liberarse cupo.
            </p>
          )}
          {c.status === 'pausada' && c.paused_reason === 'fuera_de_horario' && (
            <p style={{ fontSize: '12px', color: '#c47a00', margin: 0, fontWeight: 600 }}>
              🕒 Pausada fuera de horario{c.window_start_min != null ? ` · retoma a las ${minToHHMM(c.window_start_min)}` : ''}.
            </p>
          )}
          {c.status === 'pausada' && c.paused_reason === 'cupo_diario' && (() => {
            const r = currentRampInfo(c);
            return (
              <p style={{ fontSize: '12px', color: '#c47a00', margin: 0, fontWeight: 600 }}>
                📆 Pausada por el cronograma{r ? ` · semana ${r.week}, ${r.limit}/día` : ''} · retoma automáticamente mañana.
              </p>
            );
          })()}
          {/* Chip del cronograma vigente con progreso en vivo del día (X/Y hoy). */}
          {c.status !== 'completada' && (() => {
            const r = currentRampInfo(c);
            if (!r) return null;
            const used = c.ramp_used_today ?? 0;
            const full = used >= r.limit;
            // Lleno = mismo rojo de alerta que la card del límite de Meta (consistencia visual).
            const chipColor = full ? { color: '#c0392b', background: '#ffe6e6' } : { color: '#3a5bb8', background: '#eef3ff' };
            return (
              <span style={{ alignSelf: 'flex-start', fontSize: '11px', fontWeight: 700, ...chipColor, borderRadius: '8px', padding: '3px 10px' }}>
                📆 Cronograma · semana {r.week} · {used}/{r.limit} hoy
              </span>
            );
          })()}

          {/* Por qué están fallando los envíos (traducido). Va en la card activa/
              pausada —no solo en el historial— para diagnosticar mientras corre. */}
          <FailureReasons reasons={c.failure_reasons} />

          {(c.status === 'enviando' || c.status === 'pausada') && (
            <button onClick={() => handleStop(c)} style={{ alignSelf: 'flex-start', background: 'transparent', color: '#a33a3a', fontWeight: 700, fontSize: '13px', border: '1px solid #e0a0a0', borderRadius: '10px', padding: '8px 14px', cursor: 'pointer' }}>
              ⏹ Detener
            </button>
          )}

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
        // Terminales del período: completadas (mandaron todo) + canceladas (detenidas).
        const terminadas = campaigns.filter((c) => (c.status === 'completada' || c.status === 'cancelada') && new Date(c.created_at).getTime() >= rangeStart);

        return (
          <div style={{ background: '#fff', borderRadius: '16px', boxShadow: '0 2px 10px rgba(0,0,0,0.07)', overflow: 'hidden' }}>
            <button onClick={() => setHistoryOpen(!historyOpen)} style={{ width: '100%', background: 'none', border: 'none', padding: '16px 22px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', cursor: 'pointer', textAlign: 'left' }}>
              <span style={{ fontSize: '15px', fontWeight: 800, color: '#000' }}>
                📜 Historial de envíos
                <span style={{ fontSize: '12px', fontWeight: 600, color: '#999', marginLeft: '8px' }}>{terminadas.length} campaña{terminadas.length !== 1 ? 's' : ''}</span>
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

                {terminadas.length === 0 ? (
                  <p style={{ textAlign: 'center', padding: '20px 0', color: '#999', fontSize: '13px', margin: 0 }}>No hay campañas en este período.</p>
                ) : (
                  terminadas.map((c) => {
                    const sent = c.sent_count ?? c.recipient_ids?.length ?? 0;
                    const noCount = c.btn2_count ?? 0;
                    return (
                      <div key={c.id} style={{ background: '#F8F8F8', borderRadius: '12px', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
                          <div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                              <p style={{ fontSize: '14px', fontWeight: 800, color: '#000', margin: 0 }}>{c.name}</p>
                              {(() => {
                                const b = c.status === 'cancelada'
                                  ? { bg: '#f3d9d9', fg: '#a33a3a', label: 'Detenida' }
                                  : { bg: '#e8fff0', fg: '#1a7a3a', label: 'Completa' };
                                return (
                                  <span style={{ background: b.bg, color: b.fg, fontSize: '10px', fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase', padding: '3px 10px', borderRadius: '20px', whiteSpace: 'nowrap' }}>
                                    {b.label}
                                  </span>
                                );
                              })()}
                            </div>
                            <p style={{ fontSize: '12px', color: '#999', margin: '3px 0 0 0' }}>
                              {new Date(c.created_at).toLocaleDateString('es-AR')}
                              {c.template_name && <> · <code>{c.template_name}</code></>}
                            </p>
                          </div>
                          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                            {c.status === 'cancelada' && (
                              <button
                                onClick={() => openEditWizard(c)}
                                style={{ background: 'transparent', color: '#1a7a3a', fontWeight: 700, fontSize: '12px', border: '1px solid #86efac', borderRadius: '10px', padding: '7px 12px', cursor: 'pointer', whiteSpace: 'nowrap' }}
                              >
                                ✏️ Editar y relanzar
                              </button>
                            )}
                            {noCount > 0 && (
                              <button
                                onClick={() => handleDeleteNo(c)}
                                disabled={deletingNo === c.id}
                                style={{ background: 'transparent', color: '#E53935', fontWeight: 700, fontSize: '12px', border: '1px solid #f08080', borderRadius: '10px', padding: '7px 12px', cursor: deletingNo === c.id ? 'not-allowed' : 'pointer', opacity: deletingNo === c.id ? 0.6 : 1, whiteSpace: 'nowrap' }}
                              >
                                {deletingNo === c.id ? 'Eliminando…' : `🗑 Eliminar los que dijeron No (${noCount})`}
                              </button>
                            )}
                            <button
                              onClick={() => handleDelete(c)}
                              style={{ background: 'transparent', color: '#E53935', fontWeight: 700, fontSize: '12px', border: '1px solid #f08080', borderRadius: '10px', padding: '7px 12px', cursor: 'pointer', whiteSpace: 'nowrap' }}
                            >
                              Eliminar campaña
                            </button>
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                          <Chip label="enviados"   value={sent}                color="#555"    bg="#ececec" />
                          <Chip label="entregados" value={c.delivered_count ?? 0} color="#1565c0" bg="#e3f0ff" />
                          <Chip label="leídos"     value={c.read_count ?? 0}    color="#1a7a3a" bg="#e8fff0" />
                          <Chip label="btn1"       value={c.btn1_count ?? 0}    color="#5b7a00" bg="#f4ffd1" />
                          <Chip label="btn2"       value={c.btn2_count ?? 0}    color="#b8860b" bg="#fff4d6" />
                          <Chip label="fallidos"   value={c.failed_count ?? 0}  color="#c0392b" bg="#ffe6e6" />
                        </div>
                        <FailureReasons reasons={c.failure_reasons} />
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
