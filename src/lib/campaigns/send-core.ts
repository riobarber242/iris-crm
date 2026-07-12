import { supabaseAdmin } from '@/lib/db';
import { sendWhatsAppText, sendWhatsAppTemplate } from '@/lib/meta/client';
import { insertMessage } from '@/lib/messages';
import { notifyActiveAgents } from '@/lib/push';

// Núcleo del envío de campañas, extraído de la ruta /api/campaigns/send para que
// también lo pueda invocar el cron de auto-resume (que no tiene sesión). La ruta
// es un wrapper delgado: autentica y llama a runCampaignBatch con el tenant de la
// sesión; el cron lo llama con el tenant de la campaña pausada.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Chunk para los `.in([...])`: supabase-js los manda como query string; con >~180
// UUIDs se excede el largo de URL (Cloudflare/PostgREST → 414) y la query fallaría
// EN SILENCIO. Lotes de 200 mantienen la URL chica.
const IN_CHUNK = 200;

// Presupuesto de tiempo del loop: cortamos antes de maxDuration (300s) para
// terminar limpio, dejar la campaña 'enviando' y que se reanude (auto-resume).
const TIME_BUDGET_MS = 270_000;

// Cada cuántos envíos re-consultamos el uso real del tenant (para atrapar envíos
// concurrentes de otras líneas/campañas contra el techo compartido de Meta). Entre
// re-consultas usamos el baseline + el contador local, así no pegamos a la DB por
// cada mensaje.
const USAGE_RECHECK_EVERY = 50;

// Ventana móvil de 24h: así cuenta Meta el límite (destinatarios únicos en las
// últimas 24h), no por día calendario. Es la opción segura (nunca sobrepasa).
const WINDOW_MS = 24 * 60 * 60 * 1000;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ── Ventana horaria (hora Argentina) ─────────────────────────────────────────
// AR = UTC−3 todo el año (sin DST desde 2009; el resto del sistema ya asume
// "medianoche AR = 03:00 UTC"). Trabajamos en minutos desde medianoche AR.
const AR_OFFSET_MIN = 180; // UTC−3

// Minutos desde medianoche en hora AR para un instante dado (default: ahora).
export function argMinutesOfDay(date: Date = new Date()): number {
  const utcMin = date.getUTCHours() * 60 + date.getUTCMinutes();
  return ((utcMin - AR_OFFSET_MIN) % 1440 + 1440) % 1440;
}

// ¿`nowMin` está dentro de [startMin, endMin)? Solo ventanas del mismo día
// (start < end, validado en el wizard). Si la ventana es null/ inválida devolvemos
// true (sin restricción → fail-open: nunca bloqueamos un envío por config rota).
export function withinWindow(
  startMin: number | null | undefined,
  endMin: number | null | undefined,
  nowMin: number = argMinutesOfDay(),
): boolean {
  if (startMin == null || endMin == null || startMin >= endMin) return true;
  return nowMin >= startMin && nowMin < endMin;
}

// ── Cronograma escalonado (ramp-up) — utilidades de calendario AR ─────────────
// El ramp cuenta por DÍA CALENDARIO AR (no ventana móvil) y por SEMANA calendario
// (lunes a domingo). Medianoche AR = 03:00 UTC (AR = UTC−3 fijo, sin DST).

// Inicio (ISO) del día calendario AR que contiene `now`. Borde para contar los
// envíos de la campaña "de hoy".
export function startOfArDayISO(now: Date = new Date()): string {
  const ar = new Date(now.getTime() - AR_OFFSET_MIN * 60_000);           // reloj de pared AR
  const midnightUtc = Date.UTC(ar.getUTCFullYear(), ar.getUTCMonth(), ar.getUTCDate(), AR_OFFSET_MIN / 60);
  return new Date(midnightUtc).toISOString();
}

// Lunes (fecha AR 'YYYY-MM-DD') de la semana calendario que contiene `now`. El
// create route lo usa para fijar ramp_anchor con esta misma lógica AR.
export function arMondayOf(now: Date = new Date()): string {
  const ar = new Date(now.getTime() - AR_OFFSET_MIN * 60_000);
  const isoDow = ar.getUTCDay() === 0 ? 7 : ar.getUTCDay();             // 1=lun..7=dom
  const monday = new Date(Date.UTC(ar.getUTCFullYear(), ar.getUTCMonth(), ar.getUTCDate()));
  monday.setUTCDate(monday.getUTCDate() - (isoDow - 1));
  return monday.toISOString().slice(0, 10);
}

// Índice de semana del cronograma (0 = semana de lanzamiento). anchor = lunes AR
// guardado al crear. El clamp al último escalón lo hace rampLimitToday, no acá.
function rampWeekIndex(anchor: string, now: Date = new Date()): number {
  const a = Date.parse(anchor.slice(0, 10) + 'T00:00:00Z');
  const m = Date.parse(arMondayOf(now) + 'T00:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(m)) return 0;
  return Math.max(0, Math.floor((m - a) / (7 * 24 * 3600 * 1000)));
}

// Límite diario de mensajes para HOY según el cronograma. Clampea al último escalón:
// pasada la última semana definida, sigue a ese ritmo hasta terminar (Q2). Un bloque
// parcial de arranque (ej. jueves) cae en índice 0 = Semana 1 (Q1). null = sin ramp.
export function rampLimitToday(
  schedule: number[] | null | undefined,
  anchor: string | null | undefined,
  now: Date = new Date(),
): number | null {
  if (!Array.isArray(schedule) || schedule.length === 0 || !anchor) return null;
  const idx = Math.min(rampWeekIndex(anchor, now), schedule.length - 1);
  const lim = Number(schedule[idx]);
  return Number.isFinite(lim) && lim >= 0 ? lim : null;
}

// Destinatarios únicos (todas las líneas) contactados por el tenant desde `sinceISO`.
// count(distinct contact_id) = la unidad que consume el límite de Meta. Prefiere el
// RPC (conteo en SQL); si no está migrado, cae a traer las filas y contar en JS.
export async function tenantUsageSince(tenantId: string, sinceISO: string): Promise<number> {
  try {
    const { data, error } = await supabaseAdmin.rpc('count_tenant_recipients_since', {
      tenant: tenantId,
      since: sinceISO,
    });
    if (!error && typeof data === 'number') return data;
  } catch {
    /* RPC no migrado: fallback abajo */
  }
  const { data: camps } = await supabaseAdmin.from('campaigns').select('id').eq('tenant_id', tenantId);
  const ids = (camps ?? []).map((c: any) => c.id);
  if (ids.length === 0) return 0;
  const set = new Set<string>();
  for (const slice of chunk(ids, IN_CHUNK)) {
    const { data } = await supabaseAdmin
      .from('campaign_recipients')
      .select('contact_id')
      .in('campaign_id', slice)
      .gte('sent_at', sinceISO);
    for (const r of data ?? []) set.add(r.contact_id);
  }
  return set.size;
}

// Cantidad de envíos de UNA campaña desde `sinceISO` (para el ritmo por-día del
// ramp-up: sinceISO = inicio del día calendario AR). Cuenta filas (cada intento),
// NO distinct: el ramp limita mensajes/día de esta campaña. head+count = barato.
export async function campaignSentSince(campaignId: string, sinceISO: string): Promise<number> {
  const { count, error } = await supabaseAdmin
    .from('campaign_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', campaignId)
    .gte('sent_at', sinceISO);
  if (error) {
    console.warn('[campaign send] No se pudo contar envíos del día (ramp):', error.message);
    return 0;
  }
  return count ?? 0;
}

async function resolveContacts(filter: string, tenantId: string, targetNumberId: string | null) {
  let base = supabaseAdmin
    .from('contacts').select('id, phone, name, whatsapp_number_id').eq('tenant_id', tenantId).neq('blocked', true)
    .order('created_at', { ascending: true });

  // Campaña segmentada por línea: solo contactos asignados a ese número.
  if (targetNumberId) base = base.eq('whatsapp_number_id', targetNumberId);

  if (filter.startsWith('phone:')) {
    const phone = filter.slice('phone:'.length).trim();
    const { data } = await base.eq('phone', phone);
    return data ?? [];
  }

  // Inactivos sin recargar en los últimos X días (X dinámico: inactivo_Xd).
  const inactiveMatch = filter.match(/^inactivo_(\d+)d$/);
  if (inactiveMatch) {
    const days   = Math.min(365, Math.max(1, Number(inactiveMatch[1])));
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();

    const [{ data: inactivos }, { data: recentRecargas }] = await Promise.all([
      base.eq('status', 'inactivo'),
      supabaseAdmin
        .from('comprobantes')
        .select('contact_id')
        .eq('tenant_id', tenantId)
        .eq('estado', 'verificado')
        .gte('created_at', cutoff)
        .order('created_at', { ascending: true }),
    ]);

    const recentIds = new Set((recentRecargas ?? []).map((r: any) => r.contact_id));
    return (inactivos ?? []).filter((c: any) => !recentIds.has(c.id));
  }

  if (filter && filter !== 'todos') {
    const { data } = await base.eq('status', filter);
    return data ?? [];
  }

  const { data } = await base;
  return data ?? [];
}

export type SendResult = {
  ok: true;
  done: boolean;          // true = campaña terminada; false = hay que reanudar (tiempo o pausa)
  paused: boolean;        // true = se pausó por techo de Meta, horario o cupo diario (NO reintentar ya)
  reason: 'daily_limit' | 'fuera_de_horario' | 'cupo_diario' | null;
  sent: number;           // éxitos de ESTA tanda
  sentTotal: number;      // éxitos acumulados
  attemptedTotal: number; // intentos acumulados (para el progreso)
  total: number;          // universo objetivo
  remaining: number;
  usedToday: number | null; // destinatarios ya usados en la ventana de 24h (si hay techo)
  cap: number | null;       // techo diario aplicado (daily_cap)
  rampLimit: number | null;     // límite del cronograma para hoy (si hay ramp)
  rampUsedToday: number | null; // envíos de esta campaña en el día calendario AR (si hay ramp)
  cancelled: boolean;           // true = se detuvo (status 'cancelada') durante la tanda; el loop corta
  handedOff: boolean;           // true = se cortó por tiempo → queda 'pausada'/'auto_resume' y la sigue el cron; el navegador deja de manejarla
};

export type SendError = { error: string; status: number };

// Corre UNA tanda de envío de la campaña (acotada por tiempo o por el techo diario).
// opts.notifyOnPause: enviar push al pausar por el techo (true en el lanzamiento
//   interactivo; false desde el cron, para no re-notificar en cada reintento).
// El corte por TIEMPO (presupuesto de tanda) SIEMPRE deja la campaña 'pausada' con
// reason 'auto_resume', tanto en el camino interactivo como en el del cron: así el
// cron la retoma en la próxima corrida y NUNCA queda huérfana en 'enviando' (antes,
// el camino interactivo la dejaba 'enviando' esperando al navegador → si se cerraba
// la pestaña, no la retomaba nadie porque el cron solo levanta 'pausada'). El
// resultado marca handedOff=true para que el loop del navegador ceda el control al
// cron (y no maneje la misma campaña en paralelo → evita doble envío).
export async function runCampaignBatch(
  campaignId: string,
  tenantId: string,
  opts: { notifyOnPause?: boolean } = {},
): Promise<SendResult | SendError> {
  const { data: campaign, error: cErr } = await supabaseAdmin
    .from('campaigns').select('*').eq('id', campaignId).eq('tenant_id', tenantId).single();

  if (cErr || !campaign) return { error: 'Campaña no encontrada', status: 404 };
  if (campaign.status === 'completada') return { error: 'La campaña ya fue enviada', status: 409 };
  // Detenida por el operador: no arrancamos ni la revivimos a 'enviando'.
  if (campaign.status === 'cancelada') return { error: 'La campaña fue detenida', status: 409 };

  await supabaseAdmin.from('campaigns')
    .update({ status: 'enviando', paused_reason: null, paused_at: null })
    .eq('id', campaignId).eq('tenant_id', tenantId);

  // Selección individual (por id) tiene prioridad sobre el filtro por categoría.
  // Se re-valida contra el tenant y se respeta `blocked`.
  const explicitIds: string[] = Array.isArray(campaign.recipient_ids)
    ? campaign.recipient_ids.filter((x: unknown) => typeof x === 'string')
    : [];
  let contacts: any[];
  if (explicitIds.length > 0) {
    // Chunkeamos el `.in('id')` (URL-safety) y NO tragamos el error: antes
    // `const { data } = ...` devolvía [] ante un 414 → "0 enviados" en silencio.
    contacts = [];
    for (const slice of chunk(explicitIds, IN_CHUNK)) {
      const { data, error } = await supabaseAdmin
        .from('contacts')
        .select('id, phone, name, whatsapp_number_id')
        .eq('tenant_id', tenantId)
        .in('id', slice)
        .neq('blocked', true);
      if (error) {
        // Revertimos a 'borrador' para poder reintentar y devolvemos el error real.
        await supabaseAdmin.from('campaigns').update({ status: 'borrador' }).eq('id', campaignId).eq('tenant_id', tenantId);
        return { error: `Error resolviendo destinatarios: ${error.message}`, status: 500 };
      }
      contacts.push(...(data ?? []));
    }
  } else {
    contacts = await resolveContacts(campaign.target_filter ?? 'todos', tenantId, campaign.target_number_id ?? null);
  }

  // Exclusión inteligente: no reenviar a contactos ya contactados por las
  // campañas seleccionadas. Se re-validan los ids contra el tenant.
  const excludeIds: string[] = Array.isArray(campaign.exclude_campaign_ids) ? campaign.exclude_campaign_ids : [];
  if (excludeIds.length > 0) {
    try {
      const { data: ownCampaigns } = await supabaseAdmin
        .from('campaigns').select('id').eq('tenant_id', tenantId).in('id', excludeIds);
      const validIds = (ownCampaigns ?? []).map((c: any) => c.id);
      if (validIds.length > 0) {
        const { data: prev } = await supabaseAdmin
          .from('campaign_recipients').select('contact_id').in('campaign_id', validIds);
        const alreadySent = new Set((prev ?? []).map((r: any) => r.contact_id));
        contacts = contacts.filter((c: any) => !alreadySent.has(c.id));
      }
    } catch (err) {
      console.warn('[campaign send] Exclusión falló (¿tabla campaign_recipients?), envío sin excluir:', err);
    }
  }

  // Orden estable (por id) para que el slice de send_limit y la reanudación sean
  // deterministas entre llamadas: el `.in()` y los joins no garantizan orden.
  contacts.sort((a: any, b: any) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // send_limit acota el universo TOTAL de la campaña (estable entre llamadas de resume).
  const sendLimit = campaign.send_limit ? Number(campaign.send_limit) : null;
  if (sendLimit) contacts = contacts.slice(0, sendLimit);
  const totalTarget = contacts.length;

  // ── Reanudación: saltear a quienes YA se intentó en ESTA campaña ──────────────
  // campaign_recipients registra cada intento (éxito o fallo, ver más abajo). Tras un
  // corte por presupuesto de tiempo, filtramos esos: no reenviamos y el avance es
  // monótono (garantiza que el loop termine aunque un contacto falle siempre). Si la
  // tabla no existe, simplemente no reanuda.
  let attemptedBefore = 0;
  try {
    const { data: prevDone } = await supabaseAdmin
      .from('campaign_recipients').select('contact_id').eq('campaign_id', campaignId);
    const attempted = new Set((prevDone ?? []).map((r: any) => r.contact_id));
    attemptedBefore = attempted.size;
    contacts = contacts.filter((c: any) => !attempted.has(c.id));
  } catch (err) {
    console.warn('[campaign send] No se pudo leer el progreso previo (¿tabla campaign_recipients?):', err);
  }

  const isTemplate = campaign.type === 'template_meta';
  const vars: string[] = Array.isArray(campaign.template_variables) ? campaign.template_variables : [];

  // Botones de respuesta rápida de la plantilla (viven en whatsapp_templates).
  let buttons: string[] = [];
  if (isTemplate && campaign.template_name) {
    const { data: tpl } = await supabaseAdmin
      .from('whatsapp_templates')
      .select('buttons')
      .eq('tenant_id', tenantId)
      .eq('name', campaign.template_name)
      .maybeSingle();
    if (Array.isArray(tpl?.buttons)) buttons = tpl.buttons;
  }

  // ── Config de ritmo de envío (con defaults seguros si faltan columnas) ───────
  const intervalMin = Math.max(0, Number(campaign.interval_min_sec ?? 1) || 0);
  const intervalMax = Math.max(intervalMin, Number(campaign.interval_max_sec ?? 3) || 0);
  const pauseEvery  = Math.max(0, Number(campaign.pause_every ?? 0) || 0);
  const pauseSecs   = Math.max(0, Number(campaign.pause_seconds ?? 0) || 0);

  // ── Techo diario de Meta (pacing) ────────────────────────────────────────────
  // daily_cap = techo ABSOLUTO elegido en el wizard (margen % × límite real). null =
  // sin tope (feature off / ilimitado / ilegible): se envía como antes. La cuenta
  // "usado" es de destinatarios únicos del TENANT en la ventana móvil de 24h (todas
  // las líneas), porque el límite de Meta es compartido por el portfolio.
  const cap = campaign.daily_cap != null ? Number(campaign.daily_cap) : null;
  const sinceISO = () => new Date(Date.now() - WINDOW_MS).toISOString();
  let usedBaseline = cap != null ? await tenantUsageSince(tenantId, sinceISO()) : 0;

  // ── Ventana horaria (pacing por horario, hora AR) ────────────────────────────
  // Fuera de [window_start_min, window_end_min) se pausa con 'fuera_de_horario'.
  // null/ inválida = sin restricción. Se chequea en cada iteración (barato) para
  // atrapar el cruce del borde de la ventana a mitad de tanda.
  const winStart = campaign.window_start_min != null ? Number(campaign.window_start_min) : null;
  const winEnd   = campaign.window_end_min   != null ? Number(campaign.window_end_min)   : null;

  // ── Cronograma escalonado (ramp-up, pacing por-campaña-por-día calendario AR) ──
  // Capa que se COMBINA con el techo de Meta: el límite efectivo del día es
  // min(rampLimit, cap). ramp_schedule/ramp_anchor null → sin ramp (se ignora esta
  // compuerta). El conteo es por-campaña en el día calendario AR: baseline de la DB
  // + los intentos de esta tanda (que ocurren hoy). Se lee una vez al inicio: las
  // tandas corren dentro de la ventana horaria (lejos de medianoche), no cruzan el
  // borde del día. Al reabrir un día nuevo el baseline arranca en 0 y el cron retoma.
  const rampSchedule: number[] = Array.isArray(campaign.ramp_schedule)
    ? campaign.ramp_schedule.map((n: any) => Number(n)).filter((n: number) => Number.isFinite(n))
    : [];
  const rampAnchor: string | null = campaign.ramp_anchor ? String(campaign.ramp_anchor) : null;
  const rampLimit = rampLimitToday(rampSchedule, rampAnchor);
  const rampUsedBaseline = rampLimit != null ? await campaignSentSince(campaignId, startOfArDayISO()) : 0;

  // El intervalo lo fija el usuario, así que el tope real del lote es por TIEMPO,
  // no por cantidad. Cortamos antes de maxDuration y se reanuda.
  const startedAt = Date.now();
  let sent = 0;                        // éxitos de ESTA tanda
  const attemptedIds: string[] = [];   // intentados (éxito o fallo) de ESTA tanda
  let timedOut = false;
  let pauseReason: 'daily_limit' | 'fuera_de_horario' | 'cupo_diario' | null = null;

  for (const contact of contacts) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) { timedOut = true; break; }

    // 1) Compuerta de HORARIO (primero: en el caso combinado, el banner
    //    'fuera_de_horario' con "retoma a las HH:MM" es el más accionable).
    if (!withinWindow(winStart, winEnd)) { pauseReason = 'fuera_de_horario'; break; }

    // 2) Compuerta del RAMP-UP (ritmo por-campaña en el día calendario AR). Se pausa
    //    con 'cupo_diario' y retoma sola a la medianoche AR siguiente (el cron
    //    recomputa el conteo del nuevo día). Va antes que el techo de Meta: el ramp
    //    (20–50/día) es mucho más bajo, así que es el que realmente frena, y su
    //    banner "retoma mañana" es el accionable. usado = baseline + intentos de
    //    esta tanda (todos de hoy; el baseline de la DB no los incluye aún).
    if (rampLimit != null && rampUsedBaseline + attemptedIds.length >= rampLimit) {
      pauseReason = 'cupo_diario'; break;
    }

    // 3) Compuerta del TECHO diario de Meta. usado = baseline + intentos de esta
    //    tanda. Los intentos de esta tanda se insertan en campaign_recipients recién
    //    al final, así que el baseline (que sale de la DB) NO los incluye: sumar
    //    attemptedIds.length es exacto. Cada USAGE_RECHECK_EVERY refrescamos el
    //    baseline para atrapar envíos concurrentes de OTRAS campañas/líneas contra
    //    el techo compartido de Meta (esos sí ya están commiteados en la DB).
    if (cap != null) {
      if (attemptedIds.length > 0 && attemptedIds.length % USAGE_RECHECK_EVERY === 0) {
        usedBaseline = await tenantUsageSince(tenantId, sinceISO());
      }
      if (usedBaseline + attemptedIds.length >= cap) { pauseReason = 'daily_limit'; break; }
    }

    try {
      const resolvedVars = vars.map((v: string) =>
        v.trim().toLowerCase() === '{{nombre}}' ? (contact.name ?? contact.phone) : v
      );

      // Cada contacto recibe por SU número (el último por el que habló);
      // sin número asignado, resolveCreds cae al default del tenant.
      let wamid: string | null = null;
      if (isTemplate) {
        wamid = await sendWhatsAppTemplate(
          contact.phone,
          campaign.template_name,
          campaign.template_language ?? 'es',
          resolvedVars,
          undefined,
          tenantId,
          contact.whatsapp_number_id,
          buttons,
        );
      } else {
        await sendWhatsAppText(contact.phone, campaign.message, tenantId, contact.whatsapp_number_id);
      }

      const msgContent = isTemplate
        ? `[Template: ${campaign.template_name}]${resolvedVars.length ? ` (${resolvedVars.join(', ')})` : ''}`
        : campaign.message;

      await insertMessage({
        contact_id: contact.id,
        role:       'human',
        content:    msgContent,
        tenant_id:  tenantId,
        // Guardamos el wamid en la fila del mensaje (no solo en
        // campaign_message_status) para que las reacciones entrantes del cliente
        // matcheen esta burbuja: el handler de reacción hace
        // UPDATE messages SET reaction WHERE whatsapp_message_id = <wamid>.
        // Para envíos de texto wamid es null (igual que antes).
        whatsapp_message_id: wamid,
      });

      // Registrar el envío para trackear ticks y respuestas de botón por wamid.
      if (isTemplate && wamid) {
        const { error: cmsErr } = await supabaseAdmin.from('campaign_message_status').insert({
          campaign_id: campaignId,
          contact_id:  contact.id,
          tenant_id:   tenantId,
          wamid,
          status:      'sent',
        });
        if (cmsErr) console.warn('[campaign send] No se registró campaign_message_status (¿tabla?):', cmsErr.message);
      }

      sent++;
    } catch {
      console.error(`[campaign send] Falló envío a ${contact.phone}`);
    }

    // Registramos el intento (éxito o fallo) para reanudar sin reenviar y garantizar
    // que el progreso avance aunque un contacto falle siempre.
    attemptedIds.push(contact.id);

    // Pausa automática cada N mensajes; si no, intervalo aleatorio entre min y max.
    if (pauseEvery > 0 && pauseSecs > 0 && sent > 0 && sent % pauseEvery === 0) {
      await sleep(pauseSecs * 1000);
    } else {
      const delayMs = (intervalMin + Math.random() * (intervalMax - intervalMin)) * 1000;
      await sleep(delayMs);
    }
  }

  // Registrar los intentos de ESTA tanda: sirve para reanudar (arriba) y para que
  // futuras campañas puedan excluir a los ya contactados. Si la tabla no existe, no rompe.
  if (attemptedIds.length > 0) {
    const { error: recErr } = await supabaseAdmin
      .from('campaign_recipients')
      .insert(attemptedIds.map((cid) => ({ campaign_id: campaignId, contact_id: cid })));
    if (recErr) console.warn('[campaign send] No se registraron destinatarios (¿tabla campaign_recipients?):', recErr.message);
  }

  const attemptedTotal = attemptedBefore + attemptedIds.length;   // intentos acumulados
  const sentTotal = (Number(campaign.sent_count) || 0) + sent;    // éxitos acumulados
  // done: sin cortes (ni tiempo ni pausa) Y sin más destinatarios pendientes.
  const done = !timedOut && !pauseReason;

  // Estado resultante:
  //  - pausada por techo de Meta u horario → 'pausada' con su reason (banner + push;
  //    el cron la retoma cuando se cumplan las compuertas: cupo y/o ventana horaria).
  //  - terminada                           → 'completada'.
  //  - cortada por TIEMPO (interactivo o cron) → 'pausada'/'auto_resume': continuación
  //    silenciosa que el cron retoma en la próxima corrida. NUNCA queda en 'enviando'
  //    (evita el estado huérfano si se cierra la pestaña).
  let newStatus: string;
  let newReason: string | null;
  if (pauseReason)  { newStatus = 'pausada';    newReason = pauseReason; }
  else if (done)    { newStatus = 'completada'; newReason = null; }
  else              { newStatus = 'pausada';    newReason = 'auto_resume'; }

  // Anti-carrera "Detener": el operador pudo tocar Detener MIENTRAS corría esta tanda.
  // Re-leemos el estado antes de escribir; si quedó 'cancelada', la respetamos —
  // solo persistimos el progreso (sent_count) y NO la revivimos a enviando/pausada.
  const { data: fresh } = await supabaseAdmin
    .from('campaigns').select('status').eq('id', campaignId).eq('tenant_id', tenantId).single();
  const wasCancelled = fresh?.status === 'cancelada';

  if (wasCancelled) {
    await supabaseAdmin.from('campaigns')
      .update({ sent_count: sentTotal })
      .eq('id', campaignId).eq('tenant_id', tenantId);
  } else {
    const isPaused = newStatus === 'pausada';
    await supabaseAdmin
      .from('campaigns')
      .update({
        status:        newStatus,
        sent_count:    sentTotal,
        paused_reason: newReason,
        paused_at:     isPaused ? new Date().toISOString() : null,
      })
      .eq('id', campaignId).eq('tenant_id', tenantId);
  }

  // Aviso por push al pausar (banner lo maneja la pantalla por estado). Solo en el
  // lanzamiento interactivo; el cron no re-notifica en cada reintento. Si se detuvo
  // en el medio, no avisamos de una "pausa" que ya no aplica.
  if (pauseReason && opts.notifyOnPause && !wasCancelled) {
    const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    const body =
      pauseReason === 'fuera_de_horario'
        ? `"${campaign.name}" quedó fuera del horario configurado${winStart != null ? ` — retoma a las ${hhmm(winStart)}` : ''}.`
        : pauseReason === 'cupo_diario'
          ? `"${campaign.name}" alcanzó su límite diario del cronograma${rampLimit != null ? ` (${rampLimit}/día)` : ''}. Retoma automáticamente mañana.`
          : `"${campaign.name}" alcanzó el límite diario de Meta. Retoma automáticamente cuando se libere cupo.`;
    try {
      await notifyActiveAgents({ title: 'IRIS · Campaña pausada', body, url: '/campanas', kind: 'conversation' });
    } catch (err) {
      console.warn('[campaign send] No se pudo notificar la pausa por push:', err);
    }
  }

  const usedToday = cap != null ? usedBaseline + attemptedIds.length : null;
  return {
    ok: true,
    done,
    paused: !!pauseReason,
    reason: pauseReason,
    sent,
    sentTotal,
    attemptedTotal,
    total: totalTarget,
    remaining: Math.max(0, totalTarget - attemptedTotal),
    usedToday,
    cap,
    rampLimit,
    rampUsedToday: rampLimit != null ? rampUsedBaseline + attemptedIds.length : null,
    cancelled: wasCancelled,
    // Cortada por tiempo (no cancelada, no pausa por límite): quedó 'pausada'/'auto_resume'
    // y la sigue el cron → el navegador debe soltar el control (no manejarla en paralelo).
    handedOff: !wasCancelled && timedOut && !pauseReason,
  };
}
