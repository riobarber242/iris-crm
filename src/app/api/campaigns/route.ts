import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { getSessionAgent } from '@/lib/current-agent';
import { arMondayOf, startOfArDayISO } from '@/lib/campaigns/send-core';

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

// Líneas EMISORAS: desde qué número(s) sale la campaña. Elección libre del
// operador (ya no depende de a qué línea estaba asignado cada contacto), pero
// todas tienen que compartir WABA: las plantillas viven en la WABA, así que
// mezclar dos haría que Meta rechace en silencio la mitad de los envíos (132001).
// Vacío = modo legacy (cada contacto por su línea habitual).
async function senderNumberCols(
  tenantId: string,
  raw: unknown,
): Promise<{ ids: string[] } | { error: string }> {
  const ids = Array.isArray(raw)
    ? Array.from(new Set(raw.filter((x: unknown): x is string => typeof x === 'string' && !!x)))
    : [];
  if (ids.length === 0) return { ids: [] };

  const { data } = await supabaseAdmin
    .from('whatsapp_numbers').select('id, label, waba_id, active')
    .eq('tenant_id', tenantId).in('id', ids);
  const nums = (data ?? []) as { id: string; label: string | null; waba_id: string | null; active: boolean }[];

  if (nums.length !== ids.length) return { error: 'Alguna de las líneas emisoras elegidas no pertenece a esta cuenta.' };

  const inactivas = nums.filter((n) => !n.active);
  if (inactivas.length > 0) {
    return { error: `No se puede enviar desde una línea inactiva: ${inactivas.map((n) => n.label ?? n.id).join(', ')}.` };
  }

  const sinWaba = nums.filter((n) => !n.waba_id);
  if (sinWaba.length > 0) {
    return { error: `Sin WABA cargada no hay plantillas asociadas: ${sinWaba.map((n) => n.label ?? n.id).join(', ')}.` };
  }

  if (new Set(nums.map((n) => n.waba_id)).size > 1) {
    return { error: 'Las líneas emisoras son de WABAs distintas. Una campaña solo puede salir desde líneas de una misma WABA.' };
  }

  return { ids };
}

// Líneas destino de la campaña. El asistente permite elegir VARIAS, pero solo si
// pertenecen a la MISMA WABA: las plantillas viven en la WABA, así que una campaña
// que mezcle líneas de dos WABAs mandaría una plantilla inexistente por la mitad de
// los contactos y Meta la rechazaría en silencio (132001). Se valida server-side,
// no solo en la UI.
//
// Compatibilidad: si no viene la lista, se cae al target_number_id de siempre y
// target_number_ids queda null → las campañas existentes no cambian de semántica.
async function targetNumberCols(
  tenantId: string,
  singular: unknown,
  plural: unknown,
): Promise<{ cols: { target_number_id: string | null; target_number_ids: string[] | null } } | { error: string }> {
  const ids = Array.isArray(plural)
    ? Array.from(new Set(plural.filter((x: unknown): x is string => typeof x === 'string' && !!x)))
    : [];

  if (ids.length === 0) {
    if (!singular) return { cols: { target_number_id: null, target_number_ids: null } };
    const { data: num } = await supabaseAdmin
      .from('whatsapp_numbers').select('id')
      .eq('id', singular).eq('tenant_id', tenantId).maybeSingle();
    if (!num) return { error: 'Línea inválida' };
    return { cols: { target_number_id: num.id, target_number_ids: null } };
  }

  const { data } = await supabaseAdmin
    .from('whatsapp_numbers').select('id, label, waba_id')
    .eq('tenant_id', tenantId).in('id', ids);
  const nums = (data ?? []) as { id: string; label: string | null; waba_id: string | null }[];

  if (nums.length !== ids.length) return { error: 'Alguna de las líneas elegidas no pertenece a esta cuenta.' };

  // Una línea sin WABA solo es un problema cuando se combina con otras: ahí no
  // podemos garantizar que la plantilla exista en todas. Con UNA sola línea no hay
  // nada que mezclar, y rechazarla rompería el relanzamiento de campañas viejas
  // apuntadas a una línea que nunca tuvo la WABA cargada.
  const sinWaba = nums.filter((n) => !n.waba_id);
  if (sinWaba.length > 0 && nums.length > 1) {
    return { error: `Sin WABA cargada no hay plantillas asociadas: ${sinWaba.map((n) => n.label ?? n.id).join(', ')}.` };
  }

  const wabas = new Set(nums.map((n) => n.waba_id));
  if (wabas.size > 1) {
    return { error: 'Las líneas elegidas son de WABAs distintas. Una campaña solo puede usar líneas de una misma WABA.' };
  }

  // Con una sola línea también completamos el singular: así lo siguen leyendo el
  // resto de las pantallas (historial, precarga del wizard) sin cambios.
  return { cols: { target_number_id: ids.length === 1 ? ids[0] : null, target_number_ids: ids } };
}

// Backstop server-side: la plantilla elegida tiene que existir en la WABA por la
// que va a salir la campaña, y estar aprobada. Si no, Meta la rechaza en silencio
// (132001) y el intento se pierde sin aviso — que es justo el bug que esto ataja.
//
// Fail-open a propósito en dos casos, para no romper lo que hoy funciona:
//  · plantilla legacy sin waba_id → no sabemos de qué WABA es, se deja pasar.
//  · approval_status null (nunca sincronizada) → se deja pasar; solo bloqueamos
//    cuando Meta dijo explícitamente que NO está aprobada.
async function validateTemplate(
  tenantId: string,
  templateName: string,
  numberIds: string[],
): Promise<string | null> {
  // El mismo nombre puede existir en dos WABAs (o en dos idiomas): la tabla no
  // tiene unique por (tenant, name), así que traemos TODAS las filas. Con
  // maybeSingle() un homónimo hacía fallar la query y la validación se saltaba
  // entera, justo en el escenario multi-WABA para el que se escribió.
  const { data: rows } = await supabaseAdmin
    .from('whatsapp_templates')
    .select('waba_id, approval_status')
    .eq('tenant_id', tenantId).eq('name', templateName);
  const tpls = (rows ?? []) as { waba_id: string | null; approval_status: string | null }[];
  if (tpls.length === 0) return null;   // no está en Iris (cargada a mano en Meta): no opinamos

  // WABAs por las que va a salir la campaña ([] = todas las líneas → no acotamos).
  let wabasDestino = new Set<string>();
  if (numberIds.length > 0) {
    const { data: nums } = await supabaseAdmin
      .from('whatsapp_numbers').select('waba_id').eq('tenant_id', tenantId).in('id', numberIds);
    wabasDestino = new Set((nums ?? []).map((n: any) => n.waba_id).filter(Boolean) as string[]);
  }

  // Candidatas: las que viven en la WABA de destino, más las legacy sin waba_id
  // (no sabemos de cuál son, así que no las descartamos).
  const candidatas = wabasDestino.size === 0
    ? tpls
    : tpls.filter((t) => !t.waba_id || wabasDestino.has(t.waba_id));

  if (candidatas.length === 0) {
    return `La plantilla "${templateName}" pertenece a otra cuenta de WhatsApp (WABA) y no existe en la línea elegida.`;
  }

  // Alcanza con que UNA candidata esté usable: aprobada, o sin estado conocido
  // (legacy nunca sincronizada) — bloquear por "no sé" rompería lo que hoy anda.
  const usable = candidatas.some((t) => {
    const s = String(t.approval_status ?? '').toUpperCase();
    return !s || s === 'APPROVED';
  });
  if (!usable) {
    const estado = String(candidatas[0].approval_status ?? '').toUpperCase();
    return `La plantilla "${templateName}" no está aprobada por Meta (${estado}). Esperá la aprobación antes de usarla en una campaña.`;
  }
  return null;
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

  // Progreso del ramp en vivo: para las campañas con cronograma que están ACTIVAS,
  // contamos cuántas mandaron HOY (día calendario AR) — mismo criterio que el gate del
  // ramp (campaignSentSince). 1 sola query para todas; ninguna si no hay ramped activas.
  const rampedActive = (data ?? []).filter(
    (c: any) => Array.isArray(c.ramp_schedule) && c.ramp_schedule.length > 0
      && c.status !== 'completada' && c.status !== 'cancelada',
  );
  if (rampedActive.length > 0) {
    const ids = rampedActive.map((c: any) => c.id);
    const { data: recs } = await supabaseAdmin
      .from('campaign_recipients')
      .select('campaign_id')
      .in('campaign_id', ids)
      .gte('sent_at', startOfArDayISO());
    const tally = new Map<string, number>();
    for (const r of recs ?? []) tally.set(r.campaign_id, (tally.get(r.campaign_id) ?? 0) + 1);
    for (const c of rampedActive) (c as any).ramp_used_today = tally.get(c.id) ?? 0;
  }

  return NextResponse.json(data);
}

export async function POST(request: Request) {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });

  const body = await request.json();
  const { name, message, target_filter, type, template_name, template_language, template_variables, send_limit, target_number_id, target_number_ids, sender_number_ids, exclude_campaign_ids, interval_min_sec, interval_max_sec, pause_every, pause_seconds, recipient_ids, daily_cap, window_start_min, window_end_min, ramp_schedule } = body;

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

  // Líneas destino (opcional): una, varias de la misma WABA, o ninguna = todas.
  const target = await targetNumberCols(session.tenant_id, target_number_id, target_number_ids);
  if ('error' in target) return new NextResponse(target.error, { status: 400 });

  const sender = await senderNumberCols(session.tenant_id, sender_number_ids);
  if ('error' in sender) return new NextResponse(sender.error, { status: 400 });

  const campaignType = type === 'template_meta' ? 'template_meta' : 'texto_libre';

  if (campaignType === 'texto_libre' && !message?.trim()) {
    return new NextResponse('Falta mensaje', { status: 400 });
  }
  if (campaignType === 'template_meta' && !template_name?.trim()) {
    return new NextResponse('Falta nombre de template', { status: 400 });
  }
  if (campaignType === 'template_meta') {
    // La plantilla tiene que existir en la WABA por la que SALE la campaña. Con
    // emisoras elegidas son esas; sin ellas (modo legacy) caemos a las líneas
    // destino de siempre, que es como se validaban las campañas anteriores.
    const wabaScope = sender.ids.length > 0
      ? sender.ids
      : (target.cols.target_number_ids ?? (target.cols.target_number_id ? [target.cols.target_number_id] : []));
    const tplErr = await validateTemplate(session.tenant_id, template_name.trim(), wabaScope);
    if (tplErr) return new NextResponse(tplErr, { status: 400 });
  }

  const baseRow = {
    name,
    message:            campaignType === 'texto_libre' ? message : null,
    target_filter:      target_filter ?? 'todos',
    target_number_id:   target.cols.target_number_id,
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
    // Multi-línea (todas de la misma WABA). Va en configRow y no en baseRow para
    // que, si la columna todavía no está migrada, el reintento la descarte y la
    // campaña se cree igual con el target_number_id de siempre.
    target_number_ids: target.cols.target_number_ids,
    // Línea(s) emisora(s) de la campaña. Vacío → null = modo legacy (cada
    // contacto recibe por su línea habitual, como antes de este cambio).
    sender_number_ids: sender.ids.length > 0 ? sender.ids : null,
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

// Editar y relanzar una campaña DETENIDA (Pieza 3). Reusa la MISMA fila: actualiza
// los campos editados y la deja en 'borrador' para que el cliente la relance con el
// loop de /send. El salteo de "ya enviados" es gratis: runCampaignBatch filtra a los
// que ya están en campaign_recipients de ESTA campaña, así que la corrida original
// no se repite y solo se manda a los pendientes + los nuevos que se hayan agregado.
export async function PUT(request: Request) {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });

  const body = await request.json();
  const { campaignId, name, message, target_filter, type, template_name, template_language, template_variables, send_limit, target_number_id, target_number_ids, sender_number_ids, exclude_campaign_ids, interval_min_sec, interval_max_sec, pause_every, pause_seconds, recipient_ids, daily_cap, window_start_min, window_end_min, ramp_schedule } = body;

  if (!campaignId) return new NextResponse('Falta campaignId', { status: 400 });
  if (!name) return new NextResponse('Falta nombre', { status: 400 });

  // Solo se edita una campaña DETENIDA (estado terminal reversible). Las demás no:
  // borrador se edita creando; enviando/pausada hay que detenerla; completada ya cerró.
  const { data: current } = await supabaseAdmin
    .from('campaigns').select('status').eq('id', campaignId).eq('tenant_id', session.tenant_id).single();
  if (!current) return new NextResponse('Campaña no encontrada', { status: 404 });
  if (current.status !== 'cancelada') {
    return new NextResponse('Solo se puede editar una campaña detenida', { status: 409 });
  }

  const excludeIds: string[] = Array.isArray(exclude_campaign_ids)
    ? exclude_campaign_ids.filter((x: unknown) => typeof x === 'string') : [];
  const recipientIds: string[] = Array.isArray(recipient_ids)
    ? recipient_ids.filter((x: unknown) => typeof x === 'string') : [];

  const target = await targetNumberCols(session.tenant_id, target_number_id, target_number_ids);
  if ('error' in target) return new NextResponse(target.error, { status: 400 });

  const sender = await senderNumberCols(session.tenant_id, sender_number_ids);
  if ('error' in sender) return new NextResponse(sender.error, { status: 400 });

  const campaignType = type === 'template_meta' ? 'template_meta' : 'texto_libre';
  if (campaignType === 'texto_libre' && !message?.trim()) return new NextResponse('Falta mensaje', { status: 400 });
  if (campaignType === 'template_meta' && !template_name?.trim()) return new NextResponse('Falta nombre de template', { status: 400 });
  if (campaignType === 'template_meta') {
    // La plantilla tiene que existir en la WABA por la que SALE la campaña. Con
    // emisoras elegidas son esas; sin ellas (modo legacy) caemos a las líneas
    // destino de siempre, que es como se validaban las campañas anteriores.
    const wabaScope = sender.ids.length > 0
      ? sender.ids
      : (target.cols.target_number_ids ?? (target.cols.target_number_id ? [target.cols.target_number_id] : []));
    const tplErr = await validateTemplate(session.tenant_id, template_name.trim(), wabaScope);
    if (tplErr) return new NextResponse(tplErr, { status: 400 });
  }

  // Campos base + config, espejando el POST. Al relanzar la dejamos en 'borrador' y sin
  // pausa; re-anclamos el ramp a HOY (si no, un relanzamiento días después caería en
  // una semana equivocada del cronograma). NO tocamos sent_count: el salteo se apoya en
  // campaign_recipients, no en ese contador.
  const baseRow = {
    name,
    message:            campaignType === 'texto_libre' ? message : null,
    target_filter:      target_filter ?? 'todos',
    target_number_id:   target.cols.target_number_id,
    status:             'borrador',
    type:               campaignType,
    template_name:      campaignType === 'template_meta' ? template_name.trim() : null,
    template_language:  campaignType === 'template_meta' ? (template_language ?? 'es') : null,
    template_variables: campaignType === 'template_meta' ? (template_variables ?? []) : null,
    send_limit:         send_limit ? Number(send_limit) : null,
  };
  const configRow = {
    interval_min_sec: interval_min_sec != null ? Number(interval_min_sec) : 1,
    interval_max_sec: interval_max_sec != null ? Number(interval_max_sec) : 3,
    pause_every:      pause_every ? Number(pause_every) : null,
    pause_seconds:    pause_seconds ? Number(pause_seconds) : null,
    // Multi-línea (todas de la misma WABA). Va en configRow y no en baseRow para
    // que, si la columna todavía no está migrada, el reintento la descarte y la
    // campaña se cree igual con el target_number_id de siempre.
    target_number_ids: target.cols.target_number_ids,
    // Línea(s) emisora(s) de la campaña. Vacío → null = modo legacy (cada
    // contacto recibe por su línea habitual, como antes de este cambio).
    sender_number_ids: sender.ids.length > 0 ? sender.ids : null,
    daily_cap:        daily_cap != null && Number.isFinite(Number(daily_cap)) ? Number(daily_cap) : null,
    paused_reason:    null,
    paused_at:        null,
    ...windowCols(window_start_min, window_end_min),
    ...rampCols(ramp_schedule),   // rampCols re-ancla ramp_anchor = lunes AR de hoy
  };

  const scope = (q: any) => q.eq('id', campaignId).eq('tenant_id', session.tenant_id);
  const { data, error } = await scope(
    supabaseAdmin.from('campaigns')
      .update({ ...baseRow, ...configRow, exclude_campaign_ids: excludeIds, recipient_ids: recipientIds }),
  ).select('*').single();

  // Fallback si alguna columna opcional no existe todavía (mismo criterio que el POST).
  if (error) {
    console.warn('[campaigns] Update con columnas opcionales falló, reintento sin ellas:', error.message);
    const { data: retry, error: rErr } = await scope(supabaseAdmin.from('campaigns').update(baseRow)).select('*').single();
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
