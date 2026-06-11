import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { supabaseAdmin } from '@/lib/db';
import { getSessionAgent } from '@/lib/current-agent';

// Modelo de Anthropic. Se usa el alias vigente de Sonnet (claude-sonnet-4-6);
// el ID con fecha claude-sonnet-4-20250514 está deprecado y se retira el
// 2026-06-15. Dejarlo en una constante hace trivial cambiarlo.
const MODEL = 'claude-sonnet-4-6';
const MAX_TOOL_TURNS = 5;

const SYSTEM_PROMPT = `Sos Iris AI, la asistente inteligente del CRM IRIS. Solo respondés preguntas sobre la plataforma IRIS del agente (conversaciones, contactos, comprobantes, métricas del dashboard, campañas) y ayudás a personalizar el dashboard: mostrar/ocultar y reordenar widgets, y entender qué mide cada uno. Para personalizar el dashboard, indicá al usuario que abra el botón ⚙ "Personalizar" arriba del widget "Sin responder", donde puede arrastrar para reordenar, renombrar y ocultar/mostrar widgets. No respondés sobre temas externos, no explicás qué es un CRM ni cómo funciona WhatsApp. Si te preguntan algo fuera de contexto, decís: 'Solo puedo ayudarte con información de tu plataforma Iris.' Siempre respondés en español, de forma concisa y útil.

Tenés herramientas para consultar datos reales de la plataforma. Cuando la pregunta dependa de datos (cantidades, métricas, clientes, comprobantes), USÁ las herramientas antes de responder en vez de inventar números. Todas las consultas ya están limitadas automáticamente a los datos de este usuario. Si ninguna herramienta puede responder la pregunta, decí "No puedo responder eso todavía" — NUNCA inventes un número.`;

// Extensión del prompt solo para admin/agente: herramientas de actividad del equipo.
const STAFF_PROMPT_EXTRA = `

También tenés herramientas de actividad y desempeño del equipo: comprobantes_stats (cantidad, monto total, ticket promedio, mín/máx de comprobantes; filtrable por quién lo resolvió, estado, período y rango de monto), count_activity (conteo de acciones del registro de actividad: mensajes respondidos, conversaciones atendidas, inicios de sesión, cierres de sesión —con motivo manual o inactividad—, contactos editados/importados, cambios de configuración) y list_team (miembros del equipo). Cuando te pregunten por una persona ("jessica", "el operador X"), si el filtro falla o el nombre es ambiguo usá list_team para identificarla. Para "cuántos comprobantes verificó X" usá comprobantes_stats con estado=verificado y ese operador; para "ticket promedio de X" lo mismo y mirá ticket_promedio.`;

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

async function runTool(name: string, input: any, tid: string, isStaff: boolean): Promise<unknown> {
  // Defensa en profundidad: aunque a un operador nunca se le declaran las
  // herramientas de staff, si llegara a invocarse una, se rechaza acá.
  if (STAFF_TOOL_NAMES.has(name) && !isStaff) {
    return { error: 'No autorizado para esta consulta.' };
  }
  switch (name) {
    case 'get_metrics':
      return getMetrics(tid);
    case 'list_top_clients':
      return listTopClients(tid, clampLimit(input?.limit));
    case 'search_contacts':
      return searchContacts(tid, input?.query, input?.status, clampLimit(input?.limit));
    case 'comprobantes_stats':
      return comprobantesStats(tid, input);
    case 'count_activity':
      return countActivity(tid, input);
    case 'list_team':
      return listTeam(tid);
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
  const tools = isStaff ? [...TOOLS, ...STAFF_TOOLS] : TOOLS;
  const system = isStaff ? SYSTEM_PROMPT + STAFF_PROMPT_EXTRA : SYSTEM_PROMPT;

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
