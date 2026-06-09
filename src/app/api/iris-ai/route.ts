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

Tenés herramientas para consultar datos reales de la plataforma. Cuando la pregunta dependa de datos (cantidades, métricas, clientes, comprobantes), USÁ las herramientas antes de responder en vez de inventar números. Todas las consultas ya están limitadas automáticamente a los datos de este usuario.`;

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

async function runTool(name: string, input: any, tid: string): Promise<unknown> {
  switch (name) {
    case 'get_metrics':
      return getMetrics(tid);
    case 'list_top_clients':
      return listTopClients(tid, clampLimit(input?.limit));
    case 'search_contacts':
      return searchContacts(tid, input?.query, input?.status, clampLimit(input?.limit));
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
  const client = new Anthropic();
  const messages: Anthropic.MessageParam[] = [...history, { role: 'user', content: userMessage }];

  try {
    let reply = '';
    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      const resp = await client.messages.create({
        model: MODEL,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages,
      });

      if (resp.stop_reason === 'tool_use') {
        messages.push({ role: 'assistant', content: resp.content });
        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        for (const block of resp.content) {
          if (block.type === 'tool_use') {
            const out = await runTool(block.name, block.input, tid);
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
