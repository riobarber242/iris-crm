import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { getSessionAgent } from '@/lib/current-agent';
import { arMondayOf } from '@/lib/campaigns/send-core';

// Valida y normaliza la ventana horaria (minutos AR). Solo mismo día: exige
// 0 ≤ start < end ≤ 1440; si no, va null (sin restricción) para no bloquear envíos.
function windowCols(start: unknown, end: unknown): { window_start_min: number | null; window_end_min: number | null } {
  const s = Number(start), e = Number(end);
  const ok = Number.isFinite(s) && Number.isFinite(e) && s >= 0 && e <= 1440 && s < e;
  return ok ? { window_start_min: Math.round(s), window_end_min: Math.round(e) } : { window_start_min: null, window_end_min: null };
}

// Valida el cronograma escalonado (ramp-up) y fija el ancla. ramp_schedule =
// límite diario por semana calendario (enteros ≥ 1). Si es válido y no vacío, se
// guarda junto con ramp_anchor = lunes AR de HOY (semana de lanzamiento). Si no,
// ambos van null = sin ramp (la campaña usa solo el techo de Meta).
function rampCols(schedule: unknown): { ramp_schedule: number[] | null; ramp_anchor: string | null } {
  if (!Array.isArray(schedule)) return { ramp_schedule: null, ramp_anchor: null };
  const clean = schedule
    .map((n) => Math.floor(Number(n)))
    .filter((n) => Number.isFinite(n) && n >= 1);
  if (clean.length === 0) return { ramp_schedule: null, ramp_anchor: null };
  return { ramp_schedule: clean, ramp_anchor: arMondayOf(new Date()) };
}

export async function GET() {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });

  const { data, error } = await supabaseAdmin
    .from('campaigns')
    .select('*')
    .eq('tenant_id', session.tenant_id)
    .order('created_at', { ascending: false });

  if (error) return new NextResponse(error.message, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(request: Request) {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });

  const body = await request.json();
  const { name, message, target_filter, type, template_name, template_language, template_variables, send_limit, target_number_id, exclude_campaign_ids, interval_min_sec, interval_max_sec, pause_every, pause_seconds, recipient_ids, daily_cap, window_start_min, window_end_min, ramp_schedule } = body;

  if (!name) return new NextResponse('Falta nombre', { status: 400 });

  // Campañas cuyas destinatarios se excluyen de esta (se re-validan al enviar).
  const excludeIds: string[] = Array.isArray(exclude_campaign_ids)
    ? exclude_campaign_ids.filter((x: unknown) => typeof x === 'string')
    : [];

  // Selección individual de contactos (por id). Si viene no vacía, el envío usa
  // estos contactos y NO el target_filter (se re-valida por tenant al enviar).
  const recipientIds: string[] = Array.isArray(recipient_ids)
    ? recipient_ids.filter((x: unknown) => typeof x === 'string')
    : [];

  // Línea destino (opcional): debe ser un número del tenant. null = todas.
  let targetNumberId: string | null = null;
  if (target_number_id) {
    const { data: num } = await supabaseAdmin
      .from('whatsapp_numbers').select('id')
      .eq('id', target_number_id).eq('tenant_id', session.tenant_id).maybeSingle();
    if (!num) return new NextResponse('Línea inválida', { status: 400 });
    targetNumberId = num.id;
  }

  const campaignType = type === 'template_meta' ? 'template_meta' : 'texto_libre';

  if (campaignType === 'texto_libre' && !message?.trim()) {
    return new NextResponse('Falta mensaje', { status: 400 });
  }
  if (campaignType === 'template_meta' && !template_name?.trim()) {
    return new NextResponse('Falta nombre de template', { status: 400 });
  }

  const baseRow = {
    name,
    message:            campaignType === 'texto_libre' ? message : null,
    target_filter:      target_filter ?? 'todos',
    target_number_id:   targetNumberId,
    status:             'borrador',
    type:               campaignType,
    template_name:      campaignType === 'template_meta' ? template_name.trim() : null,
    template_language:  campaignType === 'template_meta' ? (template_language ?? 'es') : null,
    template_variables: campaignType === 'template_meta' ? (template_variables ?? []) : null,
    send_limit:         send_limit ? Number(send_limit) : null,
    tenant_id:          session.tenant_id,
  };

  // Config de ritmo del wizard. Columnas nuevas (supabase-campaign-tracking.sql):
  // si todavía no están migradas, el reintento de abajo las descarta.
  const configRow = {
    interval_min_sec: interval_min_sec != null ? Number(interval_min_sec) : 1,
    interval_max_sec: interval_max_sec != null ? Number(interval_max_sec) : 3,
    pause_every:      pause_every ? Number(pause_every) : null,
    pause_seconds:    pause_seconds ? Number(pause_seconds) : null,
    // Techo diario de Meta elegido en el wizard (absoluto). null = sin tope.
    daily_cap:        daily_cap != null && Number.isFinite(Number(daily_cap)) ? Number(daily_cap) : null,
    // Ventana horaria (minutos AR desde medianoche). Solo mismo día: si no es
    // start < end válido en [0,1440), va null = sin restricción.
    ...windowCols(window_start_min, window_end_min),
    // Cronograma escalonado (ramp-up): límite diario por semana + ancla (lunes AR).
    // null = sin ramp (solo techo de Meta).
    ...rampCols(ramp_schedule),
  };

  // Insert con columnas opcionales (exclude_campaign_ids + config); si alguna no
  // existe todavía, reintenta sin ellas para no perder la campaña.
  const { data, error } = await supabaseAdmin
    .from('campaigns')
    .insert({ ...baseRow, ...configRow, exclude_campaign_ids: excludeIds, recipient_ids: recipientIds })
    .select('*').single();

  if (error) {
    console.warn('[campaigns] Insert con columnas opcionales falló, reintento sin ellas:', error.message);
    const { data: retry, error: rErr } = await supabaseAdmin
      .from('campaigns').insert(baseRow).select('*').single();
    if (rErr) return new NextResponse(rErr.message, { status: 500 });
    return NextResponse.json(retry);
  }
  return NextResponse.json(data);
}

export async function DELETE(request: Request) {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });

  const { campaignId } = await request.json();
  if (!campaignId) return new NextResponse('Falta campaignId', { status: 400 });

  const { data: campaign } = await supabaseAdmin
    .from('campaigns').select('status').eq('id', campaignId).eq('tenant_id', session.tenant_id).single();
  if (!campaign) return new NextResponse('No encontrada', { status: 404 });
  // Solo se borra un estado TERMINAL (borrador nunca lanzó; cancelada/completada ya
  // no envían). Una campaña en curso o pausada hay que detenerla primero (Pieza 1).
  if (campaign.status === 'enviando' || campaign.status === 'pausada') {
    return new NextResponse('Detené la campaña antes de eliminarla', { status: 409 });
  }

  // Limpieza best-effort de las filas hijas (no hay FK con cascade en el esquema).
  // Los mensajes de la conversación (tabla messages) NO se tocan: el historial del
  // cliente se conserva. Si alguna tabla no existe, no abortamos el borrado.
  const { error: recErr } = await supabaseAdmin.from('campaign_recipients').delete().eq('campaign_id', campaignId);
  if (recErr) console.warn('[campaigns] No se pudieron borrar campaign_recipients:', recErr.message);
  const { error: cmsErr } = await supabaseAdmin
    .from('campaign_message_status').delete().eq('campaign_id', campaignId).eq('tenant_id', session.tenant_id);
  if (cmsErr) console.warn('[campaigns] No se pudieron borrar campaign_message_status:', cmsErr.message);

  const { error } = await supabaseAdmin.from('campaigns').delete().eq('id', campaignId).eq('tenant_id', session.tenant_id);
  if (error) return new NextResponse(error.message, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function PATCH(request: Request) {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });

  const body = await request.json();
  const { campaignId, status } = body;

  if (!campaignId || !['borrador', 'enviando', 'completada', 'pausada', 'cancelada'].includes(status)) {
    return new NextResponse('Falta campaignId o estado válido', { status: 400 });
  }

  // 'cancelada' = estado terminal (detener). Limpiamos el motivo/fecha de pausa para
  // que no quede un banner colgado; el cron ya ignora todo lo que no sea 'pausada'.
  const patch = status === 'cancelada'
    ? { status, paused_reason: null, paused_at: null }
    : { status };

  const { data, error } = await supabaseAdmin
    .from('campaigns').update(patch).eq('id', campaignId).eq('tenant_id', session.tenant_id).select('*').single();

  if (error) return new NextResponse(error.message, { status: 500 });
  return NextResponse.json(data);
}
