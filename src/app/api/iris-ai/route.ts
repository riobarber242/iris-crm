import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { supabaseAdmin } from '@/lib/db';
import { getSessionAgent } from '@/lib/current-agent';
import { classifyPending } from '@/lib/pending';

// Modelo de Anthropic. Se usa el alias vigente de Sonnet (claude-sonnet-4-6);
// el ID con fecha claude-sonnet-4-20250514 está deprecado y se retira el
// 2026-06-15. Dejarlo en una constante hace trivial cambiarlo.
const MODEL = 'claude-sonnet-4-6';
const MAX_TOOL_TURNS = 5;

const SYSTEM_PROMPT = `Sos Iris AI, la asistente inteligente del CRM IRIS. Solo respondés preguntas sobre la plataforma IRIS del agente (conversaciones, contactos, comprobantes, métricas del dashboard, campañas) y ayudás a personalizar el dashboard: mostrar/ocultar y reordenar widgets, y entender qué mide cada uno. Para personalizar el dashboard, indicá al usuario que abra el botón ⚙ "Personalizar" arriba del widget "Sin responder", donde puede arrastrar para reordenar, renombrar y ocultar/mostrar widgets. No respondés sobre temas externos, no explicás qué es un CRM ni cómo funciona WhatsApp. Si te preguntan algo fuera de contexto, decís: 'Solo puedo ayudarte con información de tu plataforma Iris.' Siempre respondés en español, de forma concisa y útil.

Tenés herramientas para consultar datos reales de la plataforma. Cuando la pregunta dependa de datos (cantidades, métricas, clientes, comprobantes), USÁ las herramientas antes de responder en vez de inventar números. Todas las consultas ya están limitadas automáticamente a los datos de este usuario. Si ninguna herramienta puede responder la pregunta, decí "No puedo responder eso todavía" — NUNCA inventes un número.

Podés consultar los comprobantes pendientes de verificación (get_pending_comprobantes), ver el historial completo de un cliente por nombre o teléfono (get_client_history) y revisar el estado de las conversaciones activas: chats con actividad hoy, sin responder y las pendientes más recientes (get_conversation_summary).`;

// Extensión del prompt solo para admin/agente: herramientas de actividad del equipo.
const STAFF_PROMPT_EXTRA = `

También tenés herramientas de actividad y desempeño del equipo: comprobantes_stats (cantidad, monto total, ticket promedio, mín/máx de comprobantes; filtrable por quién lo resolvió, estado, período y rango de monto), count_activity (conteo de acciones del registro de actividad: mensajes respondidos, conversaciones atendidas, inicios de sesión, cierres de sesión —con motivo manual o inactividad—, contactos editados/importados, cambios de configuración) y list_team (miembros del equipo). Cuando te pregunten por una persona ("jessica", "el operador X"), si el filtro falla o el nombre es ambiguo usá list_team para identificarla. Para "cuántos comprobantes verificó X" usá comprobantes_stats con estado=verificado y ese operador; para "ticket promedio de X" lo mismo y mirá ticket_promedio.

Además de tus herramientas actuales, podés identificar clientes inactivos con get_inactive_clients (contactos que recargaron alguna vez pero no tienen ningún comprobante en los últimos N días, default 30) y ver alertas de comprobantes sin verificar hace más de 2 horas con get_unverified_alerts.`;

// Extensión del prompt para OPERADORES: las consultas de actividad individual
// están vetadas para su rol, y NUNCA deben aproximarse con totales generales
// (sin esto, ante "¿cuánto verifiqué yo?" el modelo caía en get_metrics y
// respondía el total del negocio).
const OPERATOR_PROMPT_EXTRA = `

IMPORTANTE: este usuario tiene rol OPERADOR. Las consultas sobre actividad o desempeño individual NO están disponibles para su rol — ni sobre sí mismo ("yo", "mis comprobantes", "cuánto verifiqué") ni sobre ninguna otra persona: comprobantes verificados/rechazados por alguien, ticket promedio por persona, mensajes respondidos, conversaciones atendidas, inicios o cierres de sesión, o quiénes integran el equipo. Ante cualquiera de esas preguntas respondé exactamente: "Esa consulta está disponible solo para agentes y administradores." NO uses get_metrics ni ninguna otra herramienta para aproximar la respuesta: los totales generales del negocio NO son la actividad de una persona y responderlos en su lugar es un error.

Las herramientas de comprobantes pendientes (get_pending_comprobantes), historial de clientes (get_client_history) y estado de conversaciones (get_conversation_summary) SÍ están disponibles para este usuario: usalas con normalidad.`;

type Tool = Anthropic.Tool;

const TOOLS: Tool[] = [
  {
    name: 'get_metrics',
    description:
      'Métricas y conteos generales del CRM: total de contactos y su distribución por estado (nuevo, cliente_activo, inactivo, bloqueado), contactos nuevos hoy/últimos 7 días/este mes, total de mensajes y mensajes de hoy, comprobantes por estado (pendiente, verificado, rechazado), y monto verificado total y del mes. Usala para cualquier pregunta de "cuántos…" o de métricas del dashboard.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'list_top_clients',
    description:
      'Lista los mejores clientes ordenados por monto total de recargas (comprobantes) verificadas. Usala para preguntas sobre top clientes, quién recargó más, ranking de clientes.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Cantidad de clientes a devolver (1-25). Default 10.' },
      },
    },
  },
  {
    name: 'search_contacts',
    description:
      'Busca contactos por nombre, teléfono o usuario de casino, y/o filtra por estado. Usala para encontrar un contacto puntual o listar contactos de cierto estado.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Texto a buscar en nombre, teléfono o casino_username.' },
        status: { type: 'string', enum: ['nuevo', 'cliente_activo', 'inactivo', 'bloqueado'], description: 'Filtrar por estado del contacto.' },
        limit: { type: 'integer', description: 'Cantidad máxima a devolver (1-25). Default 10.' },
      },
    },
  },
];

// ── Herramientas operativas — disponibles para TODOS los roles ───────────────
// Pensadas para el trabajo diario del operador (y útiles también para staff).
// Todas son READ-ONLY y filtran por tenant_id internamente.

const OPS_TOOLS: Tool[] = [
  {
    name: 'get_pending_comprobantes',
    description:
      'Lista los comprobantes pendientes de verificación (hasta 20, más recientes primero) con nombre y teléfono del contacto, monto y fecha de llegada. Usala para "qué comprobantes están pendientes", "qué hay para verificar".',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_client_history',
    description:
      'Historial completo de un cliente buscado por teléfono o nombre: datos del contacto (nombre, teléfono, clasificación), total de comprobantes y monto verificado, últimos 10 comprobantes y últimos 5 mensajes de su conversación. Usala para "historial de X", "qué recargó X", "mostrame al cliente X".',
    input_schema: {
      type: 'object',
      properties: {
        phone: { type: 'string', description: 'Teléfono del cliente (puede ser parcial).' },
        name: { type: 'string', description: 'Nombre o usuario de casino del cliente (puede ser parcial).' },
      },
    },
  },
  {
    name: 'get_conversation_summary',
    description:
      'Estado de las conversaciones activas: cuántos chats tuvieron actividad hoy, cuántas conversaciones están sin responder (pendientes de atención humana, con desglose rojo/naranja) y las 5 pendientes más recientes con nombre del contacto y último mensaje. Usala para "cómo vienen las conversaciones", "cuántas hay sin responder".',
    input_schema: { type: 'object', properties: {} },
  },
];

// ── Herramientas de actividad del equipo — SOLO admin/agente ─────────────────
// Los operadores no las reciben (ni en `tools` ni en runTool: doble validación).
// Todas son READ-ONLY y filtran por tenant_id internamente.

const ACTIVITY_ACTIONS = [
  'comprobante_verificado', 'comprobante_rechazado', 'message_sent',
  'conversation_attended', 'session_login', 'session_logout',
  'contact_edited', 'contact_imported', 'config_changed',
] as const;

const PERIODOS = ['hoy', 'semana', 'mes', 'mes_anterior', 'historico'] as const;

const STAFF_TOOLS: Tool[] = [
  {
    name: 'comprobantes_stats',
    description:
      'Estadísticas de comprobantes: cantidad, monto total, ticket promedio, mínimo y máximo. Filtrable por operador (quién lo verificó/rechazó), estado, período y rango de monto. Usala para "cuántos comprobantes verificó X", "ticket promedio de X", "cuántos comprobantes hay entre $A y $B". Con operador, el período se aplica a la fecha de resolución; sin operador, a la fecha de creación.',
    input_schema: {
      type: 'object',
      properties: {
        operador:  { type: 'string', description: 'Nombre o usuario de quien resolvió el comprobante (ej: "jessica").' },
        estado:    { type: 'string', enum: ['pendiente', 'verificado', 'rechazado'], description: 'Estado del comprobante. Para "verificó" usá verificado.' },
        periodo:   { type: 'string', enum: [...PERIODOS], description: 'Rango temporal. Default: historico (todo).' },
        monto_min: { type: 'number', description: 'Monto mínimo (inclusive) en ARS.' },
        monto_max: { type: 'number', description: 'Monto máximo (inclusive) en ARS.' },
      },
    },
  },
  {
    name: 'count_activity',
    description:
      'Cuenta acciones del registro de actividad del equipo. Usala para "cuántas conversaciones atendió X", "cuántos mensajes respondió X", "cuántas veces inició/cerró sesión X", "cuántas veces se le cerró la sesión por inactividad a X". Si no filtrás operador, devuelve también el desglose por usuario.',
    input_schema: {
      type: 'object',
      properties: {
        accion:   { type: 'string', enum: [...ACTIVITY_ACTIONS], description: 'Tipo de acción a contar. message_sent = respondió un mensaje; conversation_attended = atendió una conversación; session_logout = cierre de sesión.' },
        operador: { type: 'string', description: 'Nombre o usuario de la persona (ej: "jessica"). Omitir para contar de todo el equipo.' },
        periodo:  { type: 'string', enum: [...PERIODOS], description: 'Rango temporal. Default: historico.' },
        motivo:   { type: 'string', enum: ['manual', 'inactividad'], description: 'Solo para session_logout: motivo del cierre.' },
      },
      required: ['accion'],
    },
  },
  {
    name: 'list_team',
    description:
      'Lista los miembros del equipo (nombre, usuario, rol, activo). Usala para resolver a quién se refiere el usuario ("jessica", "el operador X") cuando el nombre sea ambiguo o no se encuentre, o para preguntas sobre el equipo.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_inactive_clients',
    description:
      'Clientes inactivos: contactos que recargaron alguna vez pero no tienen ningún comprobante en los últimos N días (default 30). Devuelve nombre, teléfono, clasificación y fecha del último comprobante (hasta 20, los que dejaron de recargar más recientemente primero). Usala para "qué clientes dejaron de recargar", "clientes inactivos hace X días".',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: 'Días sin comprobantes para considerar inactivo al cliente. Default 30.' },
      },
    },
  },
  {
    name: 'get_unverified_alerts',
    description:
      'Alertas de comprobantes sin verificar: comprobantes pendientes hace más de 2 horas. Devuelve la cantidad total y los 5 más antiguos con nombre del contacto, monto y horas de espera. Usala para "hay comprobantes demorados", "alertas de verificación pendiente".',
    input_schema: { type: 'object', properties: {} },
  },
];

const STAFF_TOOL_NAMES = new Set(STAFF_TOOLS.map((t) => t.name));

function clampLimit(v: unknown, def = 10): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(25, Math.max(1, Math.floor(n)));
}

async function countRows(table: string, tid: string, apply?: (q: any) => any): Promise<number> {
  let q = supabaseAdmin.from(table).select('*', { count: 'exact', head: true }).eq('tenant_id', tid);
  if (apply) q = apply(q);
  const { count } = await q;
  return count ?? 0;
}

async function getMetrics(tid: string) {
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const startMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const start7 = new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString();

  const [
    total, nuevo, clienteActivo, inactivo, bloqueado,
    newToday, newWeek, newMonth,
    msgsTotal, msgsToday,
    compPendiente, compVerificado, compRechazado,
  ] = await Promise.all([
    countRows('contacts', tid),
    countRows('contacts', tid, (q) => q.eq('status', 'nuevo')),
    countRows('contacts', tid, (q) => q.eq('status', 'cliente_activo')),
    countRows('contacts', tid, (q) => q.eq('status', 'inactivo')),
    countRows('contacts', tid, (q) => q.eq('status', 'bloqueado')),
    countRows('contacts', tid, (q) => q.gte('created_at', startToday)),
    countRows('contacts', tid, (q) => q.gte('created_at', start7)),
    countRows('contacts', tid, (q) => q.gte('created_at', startMonth)),
    countRows('messages', tid),
    countRows('messages', tid, (q) => q.gte('created_at', startToday)),
    countRows('comprobantes', tid, (q) => q.eq('estado', 'pendiente')),
    countRows('comprobantes', tid, (q) => q.eq('estado', 'verificado')),
    countRows('comprobantes', tid, (q) => q.eq('estado', 'rechazado')),
  ]);

  const { data: verif } = await supabaseAdmin
    .from('comprobantes')
    .select('monto, created_at')
    .eq('tenant_id', tid)
    .eq('estado', 'verificado');

  let montoVerificadoTotal = 0;
  let montoVerificadoMes = 0;
  for (const r of verif ?? []) {
    const m = Number(r.monto ?? 0);
    montoVerificadoTotal += m;
    if (r.created_at && r.created_at >= startMonth) montoVerificadoMes += m;
  }

  return {
    contactos: { total, nuevo, cliente_activo: clienteActivo, inactivo, bloqueado },
    contactos_nuevos: { hoy: newToday, ultimos_7_dias: newWeek, este_mes: newMonth },
    mensajes: { total: msgsTotal, hoy: msgsToday },
    comprobantes: { pendiente: compPendiente, verificado: compVerificado, rechazado: compRechazado },
    monto_verificado: { total: montoVerificadoTotal, este_mes: montoVerificadoMes, moneda: 'ARS' },
  };
}

async function listTopClients(tid: string, limit: number) {
  const { data: comps } = await supabaseAdmin
    .from('comprobantes')
    .select('contact_id, monto')
    .eq('tenant_id', tid)
    .eq('estado', 'verificado');

  if (!comps || comps.length === 0) return { clientes: [] };

  const agg = new Map<string, { total: number; monto: number }>();
  for (const c of comps) {
    const prev = agg.get(c.contact_id) ?? { total: 0, monto: 0 };
    agg.set(c.contact_id, { total: prev.total + 1, monto: prev.monto + Number(c.monto ?? 0) });
  }

  const ids = Array.from(agg.keys());
  const { data: contacts } = await supabaseAdmin
    .from('contacts')
    .select('id, phone, name, casino_username, status')
    .eq('tenant_id', tid)
    .in('id', ids);

  const byId = new Map((contacts ?? []).map((c: any) => [c.id, c]));
  const clientes = ids
    .map((id) => {
      const c = byId.get(id) as any;
      const a = agg.get(id)!;
      return {
        nombre: c?.name ?? null,
        casino_username: c?.casino_username ?? null,
        telefono: c?.phone ?? null,
        estado: c?.status ?? null,
        recargas_verificadas: a.total,
        monto_total: a.monto,
      };
    })
    .sort((x, y) => y.monto_total - x.monto_total)
    .slice(0, limit);

  return { clientes };
}

async function searchContacts(tid: string, query: string | undefined, status: string | undefined, limit: number) {
  let q = supabaseAdmin
    .from('contacts')
    .select('phone, name, casino_username, status, created_at')
    .eq('tenant_id', tid)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (status) q = q.eq('status', status);
  if (query) {
    const s = String(query).replace(/[%,()]/g, ' ').trim();
    if (s) q = q.or(`name.ilike.%${s}%,phone.ilike.%${s}%,casino_username.ilike.%${s}%`);
  }

  const { data } = await q;
  return { contactos: data ?? [] };
}

const ROLE_LABEL: Record<string, string> = { user: 'cliente', assistant: 'bot', human: 'operador' };

function snippet(s: unknown, max = 200): string {
  const t = String(s ?? '');
  return t.length > max ? t.slice(0, max) + '…' : t;
}

async function getPendingComprobantes(tid: string) {
  const { data, error } = await supabaseAdmin
    .from('comprobantes')
    .select('id, contact_id, monto, created_at')
    .eq('tenant_id', tid)
    .eq('estado', 'pendiente')
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) return { error: error.message };
  const comps = data ?? [];
  if (comps.length === 0) return { comprobantes: [] };

  const ids = Array.from(new Set(comps.map((c: any) => c.contact_id)));
  const { data: contacts } = await supabaseAdmin
    .from('contacts')
    .select('id, name, phone')
    .eq('tenant_id', tid)
    .in('id', ids);
  const byId = new Map((contacts ?? []).map((c: any) => [c.id, c]));

  return {
    comprobantes: comps.map((c: any) => {
      const ct = byId.get(c.contact_id) as any;
      return {
        id: c.id,
        contacto: ct?.name ?? null,
        telefono: ct?.phone ?? null,
        monto: Number(c.monto ?? 0),
        created_at: c.created_at,
      };
    }),
    moneda: 'ARS',
  };
}

async function getClientHistory(tid: string, input: any) {
  const phone = String(input?.phone ?? '').replace(/[%,()]/g, ' ').trim();
  const name = String(input?.name ?? '').replace(/[%,()]/g, ' ').trim();
  if (!phone && !name) return { error: 'Indicá el teléfono o el nombre del cliente.' };

  let q = supabaseAdmin
    .from('contacts')
    .select('id, name, phone, casino_username, status, created_at')
    .eq('tenant_id', tid)
    .limit(6);
  if (phone && name) q = q.or(`phone.ilike.%${phone}%,name.ilike.%${name}%`);
  else if (phone) q = q.ilike('phone', `%${phone}%`);
  else q = q.or(`name.ilike.%${name}%,casino_username.ilike.%${name}%`);

  const { data: matches, error } = await q;
  if (error) return { error: error.message };
  if (!matches || matches.length === 0) {
    return { error: `No encontré ningún cliente que coincida con "${phone || name}".` };
  }

  let contact = matches[0];
  if (matches.length > 1) {
    const exact = matches.filter(
      (c: any) =>
        (name && (c.name ?? '').toLowerCase() === name.toLowerCase()) ||
        (phone && c.phone === phone),
    );
    if (exact.length === 1) contact = exact[0];
    else {
      return {
        error: 'Hay varios clientes que coinciden. Pedile al usuario que aclare.',
        candidatos: matches.map((c: any) => ({ nombre: c.name, telefono: c.phone })),
      };
    }
  }

  const [compsRes, msgsRes, totalRes, verifRes] = await Promise.all([
    supabaseAdmin.from('comprobantes').select('monto, estado, created_at')
      .eq('tenant_id', tid).eq('contact_id', contact.id)
      .order('created_at', { ascending: false }).limit(10),
    supabaseAdmin.from('messages').select('role, content, created_at')
      .eq('tenant_id', tid).eq('contact_id', contact.id)
      .order('created_at', { ascending: false }).limit(5),
    supabaseAdmin.from('comprobantes').select('id', { count: 'exact', head: true })
      .eq('tenant_id', tid).eq('contact_id', contact.id),
    supabaseAdmin.from('comprobantes').select('monto')
      .eq('tenant_id', tid).eq('contact_id', contact.id).eq('estado', 'verificado'),
  ]);

  const montoVerificado = (verifRes.data ?? []).reduce((s: number, r: any) => s + Number(r.monto ?? 0), 0);

  return {
    cliente: {
      nombre: contact.name ?? null,
      telefono: contact.phone ?? null,
      usuario_casino: contact.casino_username ?? null,
      clasificacion: contact.status ?? null,
      cliente_desde: contact.created_at ?? null,
    },
    comprobantes: {
      total: totalRes.count ?? 0,
      monto_verificado_total: montoVerificado,
      moneda: 'ARS',
      ultimos: (compsRes.data ?? []).map((c: any) => ({
        monto: Number(c.monto ?? 0),
        estado: c.estado,
        fecha: c.created_at,
      })),
    },
    ultimos_mensajes: (msgsRes.data ?? []).map((m: any) => ({
      de: ROLE_LABEL[m.role] ?? m.role,
      mensaje: snippet(m.content),
      fecha: m.created_at,
    })),
  };
}

// Resumen de conversaciones derivado de messages + classifyPending: la MISMA
// regla de "sin responder" que usan el dashboard y la lista de conversaciones.
async function getConversationSummary(tid: string) {
  const todayStart = periodRange('hoy').gte!;

  const [offlineRes, contactsRes, msgsRes, activeTodayRes] = await Promise.all([
    supabaseAdmin.from('settings').select('value').eq('key', 'offline_mode').eq('tenant_id', tid).limit(1).maybeSingle(),
    supabaseAdmin.from('contacts').select('id, name, phone, conversation_state, last_read_at').eq('tenant_id', tid),
    supabaseAdmin.from('messages').select('contact_id, role, content, created_at')
      .eq('tenant_id', tid).order('created_at', { ascending: false }).limit(1000),
    supabaseAdmin.from('messages').select('contact_id').eq('tenant_id', tid).gte('created_at', todayStart),
  ]);
  const offlineMode = offlineRes.data?.value === 'true';

  const lastMsgByContact = new Map<string, { role: string; content: string; created_at: string }>();
  for (const m of (msgsRes.data ?? [])) {
    if (!lastMsgByContact.has(m.contact_id)) {
      lastMsgByContact.set(m.contact_id, { role: m.role, content: m.content, created_at: m.created_at });
    }
  }

  let rojo = 0;
  let naranja = 0;
  const pendientes: { nombre: string | null; telefono: string | null; nivel: string; ultimo_mensaje: string; de: string; fecha: string }[] = [];
  for (const c of (contactsRes.data ?? [])) {
    const lm = lastMsgByContact.get(c.id as string);
    const level = classifyPending({
      lastRole: lm?.role,
      lastMsgAt: lm?.created_at,
      lastReadAt: c.last_read_at,
      conversationState: c.conversation_state,
      offline: offlineMode,
    });
    if (!level) continue;
    if (level === 'red') rojo++;
    else naranja++;
    pendientes.push({
      nombre: c.name ?? null,
      telefono: c.phone ?? null,
      nivel: level === 'red' ? 'rojo' : 'naranja',
      ultimo_mensaje: snippet(lm!.content),
      de: ROLE_LABEL[lm!.role] ?? lm!.role,
      fecha: lm!.created_at,
    });
  }
  pendientes.sort((a, b) => (a.fecha < b.fecha ? 1 : -1));

  return {
    chats_con_actividad_hoy: new Set((activeTodayRes.data ?? []).map((m: any) => m.contact_id)).size,
    sin_responder: { total: rojo + naranja, rojo, naranja },
    pendientes_mas_recientes: pendientes.slice(0, 5),
  };
}

// Fronteras de período alineadas a medianoche Argentina (UTC-3 fijo), igual que
// el dashboard. 'historico' (o vacío) = sin filtro temporal.
const ART_OFFSET_MS = 3 * 60 * 60 * 1000;

function periodRange(periodo: unknown): { gte?: string; lt?: string } {
  if (!periodo || periodo === 'historico') return {};
  const argNow = new Date(Date.now() - ART_OFFSET_MS);
  const y = argNow.getUTCFullYear(), m = argNow.getUTCMonth(), d = argNow.getUTCDate();
  const daysToMonday = (argNow.getUTCDay() + 6) % 7;
  const todayStart     = new Date(Date.UTC(y, m, d, 3, 0, 0, 0));
  const weekStart      = new Date(Date.UTC(y, m, d - daysToMonday, 3, 0, 0, 0));
  const monthStart     = new Date(Date.UTC(y, m, 1, 3, 0, 0, 0));
  const prevMonthStart = new Date(Date.UTC(y, m - 1, 1, 3, 0, 0, 0));
  switch (periodo) {
    case 'hoy':          return { gte: todayStart.toISOString() };
    case 'semana':       return { gte: weekStart.toISOString() };
    case 'mes':          return { gte: monthStart.toISOString() };
    case 'mes_anterior': return { gte: prevMonthStart.toISOString(), lt: monthStart.toISOString() };
    default:             return {};
  }
}

type TeamMember = { id: string; name: string; username: string; role: string };

// Resuelve "jessica" / "el operador X" a un miembro REAL del tenant. Si no hay
// match único devuelve un error descriptivo para que el modelo use list_team.
async function resolveTeamMember(tid: string, raw: unknown): Promise<TeamMember | { error: string; candidatos?: unknown[] }> {
  const s = String(raw ?? '').replace(/[%,()]/g, ' ').trim();
  if (!s) return { error: 'Falta el nombre del operador.' };
  const { data, error } = await supabaseAdmin
    .from('agents')
    .select('id, name, username, role')
    .eq('tenant_id', tid)
    .or(`name.ilike.%${s}%,username.ilike.%${s}%`);
  if (error) return { error: error.message };
  const matches = (data ?? []) as TeamMember[];
  if (matches.length === 0) return { error: `No encontré a "${s}" en el equipo. Usá list_team para ver los nombres reales.` };
  if (matches.length === 1) return matches[0];
  const exact = matches.filter((x) => x.name.toLowerCase() === s.toLowerCase() || x.username.toLowerCase() === s.toLowerCase());
  if (exact.length === 1) return exact[0];
  return {
    error: `Hay varias personas que coinciden con "${s}". Pedile al usuario que aclare.`,
    candidatos: matches.map((x) => ({ nombre: x.name, usuario: x.username })),
  };
}

async function comprobantesStats(tid: string, input: any) {
  const estado = ['pendiente', 'verificado', 'rechazado'].includes(input?.estado) ? input.estado : undefined;
  const montoMin = Number.isFinite(Number(input?.monto_min)) && input?.monto_min !== undefined ? Number(input.monto_min) : undefined;
  const montoMax = Number.isFinite(Number(input?.monto_max)) && input?.monto_max !== undefined ? Number(input.monto_max) : undefined;

  let resolvedBy: string | undefined;
  let operadorNombre: string | null = null;
  if (input?.operador) {
    const r = await resolveTeamMember(tid, input.operador);
    if ('error' in r) return r;
    resolvedBy = r.id;
    operadorNombre = r.name;
  }

  // Con operador, el período aplica a CUANDO se resolvió; sin operador, a cuándo
  // se creó el comprobante.
  const dateCol = resolvedBy ? 'resolved_at' : 'created_at';
  const range = periodRange(input?.periodo);

  // Paginado: PostgREST corta en ~1000 filas por request; sin esto, las
  // estadísticas quedarían silenciosamente truncadas.
  const PAGE = 1000;
  const montos: number[] = [];
  for (let from = 0; from < 10_000; from += PAGE) {
    let q = supabaseAdmin.from('comprobantes').select('monto').eq('tenant_id', tid).range(from, from + PAGE - 1);
    if (estado)              q = q.eq('estado', estado);
    if (resolvedBy)          q = q.eq('resolved_by', resolvedBy);
    if (range.gte)           q = q.gte(dateCol, range.gte);
    if (range.lt)            q = q.lt(dateCol, range.lt);
    if (montoMin !== undefined) q = q.gte('monto', montoMin);
    if (montoMax !== undefined) q = q.lte('monto', montoMax);
    const { data, error } = await q;
    if (error) return { error: error.message };
    for (const r of data ?? []) montos.push(Number(r.monto ?? 0));
    if (!data || data.length < PAGE) break;
  }

  const cantidad = montos.length;
  const suma = montos.reduce((s, n) => s + n, 0);
  return {
    filtros: {
      operador: operadorNombre, estado: estado ?? null, periodo: input?.periodo ?? 'historico',
      monto_min: montoMin ?? null, monto_max: montoMax ?? null,
    },
    cantidad,
    monto_total: suma,
    ticket_promedio: cantidad > 0 ? Math.round((suma / cantidad) * 100) / 100 : 0,
    monto_minimo: cantidad > 0 ? Math.min(...montos) : null,
    monto_maximo: cantidad > 0 ? Math.max(...montos) : null,
    moneda: 'ARS',
  };
}

async function countActivity(tid: string, input: any) {
  const accion = String(input?.accion ?? '');
  if (!(ACTIVITY_ACTIONS as readonly string[]).includes(accion)) {
    return { error: `Acción inválida. Opciones: ${ACTIVITY_ACTIONS.join(', ')}` };
  }

  let actorId: string | undefined;
  let operadorNombre: string | null = null;
  if (input?.operador) {
    const r = await resolveTeamMember(tid, input.operador);
    if ('error' in r) return r;
    actorId = r.id;
    operadorNombre = r.name;
  }

  const motivo = accion === 'session_logout' && ['manual', 'inactividad'].includes(input?.motivo) ? input.motivo : undefined;
  const range = periodRange(input?.periodo);

  const applyFilters = (q: any) => {
    q = q.eq('tenant_id', tid).eq('action', accion);
    if (actorId)   q = q.eq('actor_id', actorId);
    if (motivo)    q = q.eq('details->>reason', motivo);
    if (range.gte) q = q.gte('created_at', range.gte);
    if (range.lt)  q = q.lt('created_at', range.lt);
    return q;
  };

  const { count, error } = await applyFilters(
    supabaseAdmin.from('activity_log').select('id', { count: 'exact', head: true }),
  );
  if (error) return { error: error.message };

  const result: Record<string, unknown> = {
    accion,
    filtros: { operador: operadorNombre, periodo: input?.periodo ?? 'historico', motivo: motivo ?? null },
    cantidad: count ?? 0,
  };

  // Sin filtro de operador → desglose por usuario (solo si entra en una página,
  // para no truncar el desglose en silencio).
  if (!actorId && (count ?? 0) > 0 && (count ?? 0) <= 1000) {
    const { data } = await applyFilters(supabaseAdmin.from('activity_log').select('actor_name'));
    const por: Record<string, number> = {};
    for (const r of data ?? []) {
      const n = r.actor_name ?? '(desconocido)';
      por[n] = (por[n] ?? 0) + 1;
    }
    result.por_usuario = por;
  }

  return result;
}

async function listTeam(tid: string) {
  const { data, error } = await supabaseAdmin
    .from('agents')
    .select('username, name, role, active')
    .eq('tenant_id', tid)
    .order('created_at', { ascending: true });
  if (error) return { error: error.message };
  return {
    equipo: (data ?? []).map((a: any) => ({
      nombre: a.name,
      usuario: a.username,
      rol: a.role === 'admin' ? 'admin' : a.role === 'operator' ? 'operador' : 'agente',
      activo: !!a.active,
    })),
  };
}

async function getInactiveClients(tid: string, daysInput: unknown) {
  const n = Number(daysInput);
  const days = Number.isFinite(n) && n > 0 ? Math.min(365, Math.floor(n)) : 30;
  const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();

  // Último comprobante por contacto. Paginado (PostgREST corta en ~1000 filas);
  // al venir ordenado DESC, la primera fila de cada contacto es su más reciente.
  const PAGE = 1000;
  const lastComp = new Map<string, string>();
  for (let from = 0; from < 10_000; from += PAGE) {
    const { data, error } = await supabaseAdmin
      .from('comprobantes')
      .select('contact_id, created_at')
      .eq('tenant_id', tid)
      .order('created_at', { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) return { error: error.message };
    for (const r of data ?? []) {
      if (!lastComp.has(r.contact_id)) lastComp.set(r.contact_id, r.created_at);
    }
    if (!data || data.length < PAGE) break;
  }

  // Clientes que recargaron alguna vez pero no en los últimos N días, los que
  // dejaron de recargar más recientemente primero.
  const stale = Array.from(lastComp.entries())
    .filter(([, ts]) => ts < cutoff)
    .sort((a, b) => (a[1] < b[1] ? 1 : -1))
    .slice(0, 20);
  if (stale.length === 0) return { dias: days, clientes: [] };

  const { data: contacts, error } = await supabaseAdmin
    .from('contacts')
    .select('id, name, phone, status')
    .eq('tenant_id', tid)
    .in('id', stale.map(([id]) => id));
  if (error) return { error: error.message };
  const byId = new Map((contacts ?? []).map((c: any) => [c.id, c]));

  return {
    dias: days,
    criterio: 'contactos con al menos un comprobante histórico y ninguno en el período',
    clientes: stale.map(([id, ts]) => {
      const c = byId.get(id) as any;
      return {
        nombre: c?.name ?? null,
        telefono: c?.phone ?? null,
        clasificacion: c?.status ?? null,
        ultimo_comprobante: ts,
      };
    }),
  };
}

async function getUnverifiedAlerts(tid: string) {
  const cutoff = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  const [countRes, oldestRes] = await Promise.all([
    supabaseAdmin.from('comprobantes').select('id', { count: 'exact', head: true })
      .eq('tenant_id', tid).eq('estado', 'pendiente').lt('created_at', cutoff),
    supabaseAdmin.from('comprobantes').select('id, contact_id, monto, created_at')
      .eq('tenant_id', tid).eq('estado', 'pendiente').lt('created_at', cutoff)
      .order('created_at', { ascending: true }).limit(5),
  ]);
  if (countRes.error) return { error: countRes.error.message };
  if (oldestRes.error) return { error: oldestRes.error.message };

  const oldest = oldestRes.data ?? [];
  const byId = new Map<string, any>();
  if (oldest.length > 0) {
    const ids = Array.from(new Set(oldest.map((c: any) => c.contact_id)));
    const { data: contacts } = await supabaseAdmin
      .from('contacts')
      .select('id, name, phone')
      .eq('tenant_id', tid)
      .in('id', ids);
    for (const c of contacts ?? []) byId.set(c.id, c);
  }

  const now = Date.now();
  return {
    umbral_horas: 2,
    total_demorados: countRes.count ?? 0,
    mas_antiguos: oldest.map((c: any) => {
      const ct = byId.get(c.contact_id);
      return {
        contacto: ct?.name ?? null,
        telefono: ct?.phone ?? null,
        monto: Number(c.monto ?? 0),
        horas_esperando: Math.round(((now - new Date(c.created_at).getTime()) / 3600000) * 10) / 10,
      };
    }),
    moneda: 'ARS',
  };
}

async function runTool(name: string, input: any, tid: string, isStaff: boolean): Promise<unknown> {
  // Defensa en profundidad: aunque a un operador nunca se le declaran las
  // herramientas de staff, si llegara a invocarse una, se rechaza acá con el
  // mismo mensaje que debe ver el usuario (el modelo lo transmite tal cual).
  if (STAFF_TOOL_NAMES.has(name) && !isStaff) {
    return { error: 'Esa consulta está disponible solo para agentes y administradores.' };
  }
  switch (name) {
    case 'get_metrics':
      return getMetrics(tid);
    case 'list_top_clients':
      return listTopClients(tid, clampLimit(input?.limit));
    case 'search_contacts':
      return searchContacts(tid, input?.query, input?.status, clampLimit(input?.limit));
    case 'get_pending_comprobantes':
      return getPendingComprobantes(tid);
    case 'get_client_history':
      return getClientHistory(tid, input);
    case 'get_conversation_summary':
      return getConversationSummary(tid);
    case 'comprobantes_stats':
      return comprobantesStats(tid, input);
    case 'count_activity':
      return countActivity(tid, input);
    case 'list_team':
      return listTeam(tid);
    case 'get_inactive_clients':
      return getInactiveClients(tid, input?.days);
    case 'get_unverified_alerts':
      return getUnverifiedAlerts(tid);
    default:
      return { error: `Herramienta desconocida: ${name}` };
  }
}

export async function POST(request: Request) {
  const session = await getSessionAgent();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'Iris AI no está configurada (falta ANTHROPIC_API_KEY).' }, { status: 500 });
  }

  let body: any;
  try { body = await request.json(); } catch { body = {}; }

  const userMessage = String(body.message ?? '').trim();
  if (!userMessage) return NextResponse.json({ error: 'Mensaje vacío' }, { status: 400 });

  // Sanitizar historial: solo user/assistant con content string, últimos 20.
  const rawHistory = Array.isArray(body.history) ? body.history : [];
  const history: Anthropic.MessageParam[] = rawHistory
    .filter((m: any) => (m?.role === 'user' || m?.role === 'assistant') && typeof m?.content === 'string')
    .slice(-20)
    .map((m: any) => ({ role: m.role, content: m.content }));

  const tid = session.tenant_id;
  // Solo admin y agentes acceden a las herramientas de actividad del equipo.
  // A los operadores ni se les declaran (y runTool las rechaza igual).
  const isStaff = session.role === 'admin' || session.role === 'agent';
  const tools = isStaff ? [...TOOLS, ...OPS_TOOLS, ...STAFF_TOOLS] : [...TOOLS, ...OPS_TOOLS];
  const system = SYSTEM_PROMPT + (isStaff ? STAFF_PROMPT_EXTRA : OPERATOR_PROMPT_EXTRA);

  const client = new Anthropic();
  const messages: Anthropic.MessageParam[] = [...history, { role: 'user', content: userMessage }];

  try {
    let reply = '';
    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      const resp = await client.messages.create({
        model: MODEL,
        max_tokens: 1024,
        system,
        tools,
        messages,
      });

      if (resp.stop_reason === 'tool_use') {
        messages.push({ role: 'assistant', content: resp.content });
        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        for (const block of resp.content) {
          if (block.type === 'tool_use') {
            const out = await runTool(block.name, block.input, tid, isStaff);
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: JSON.stringify(out),
            });
          }
        }
        messages.push({ role: 'user', content: toolResults });
        continue;
      }

      reply = resp.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      break;
    }

    return NextResponse.json({ reply: reply || 'No pude generar una respuesta. Probá reformular la pregunta.' });
  } catch (err: any) {
    console.error('[iris-ai] error:', err?.message ?? err);
    return NextResponse.json({ error: 'Error consultando a Iris AI.' }, { status: 500 });
  }
}
