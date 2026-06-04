import axios from 'axios';
import { verifyMetaSignature } from './verify';
import { sendWhatsAppText } from './client';
import { supabaseAdmin } from '../db';
import { irisSystemPrompt } from '../system-prompt';
import { inferProvinciaFromPhone } from '../phone-province';

async function getSystemPrompt(): Promise<string> {
  try {
    const { data } = await supabaseAdmin
      .from('settings').select('value').eq('key', 'system_prompt').limit(1).maybeSingle();
    return data?.value ?? irisSystemPrompt;
  } catch {
    return irisSystemPrompt;
  }
}

const COMPROBANTES_BUCKET = 'comprobantes';
const BOT_ENABLED_KEY     = 'bot_enabled';

// Estados de onboarding que pertenecen al bot. Si un contacto está en uno de
// estos, el bot inició la conversación y la continúa. Cualquier otro estado
// (null en un contacto preexistente, 'done', 'en_proceso') NO es del bot.
const BOT_FLOW_STATES = new Set(['greeting', 'asked_intention', 'waiting_screenshot', 'asked_if_loader', 'asked_name']);

// Mensajes del bot.
const WELCOME_MSG     = '¡Hola! Soy Iris, asistente virtual. Para ayudarte mejor necesito hacerte unas preguntas 😊\n\n¿Venís por las fichas de prueba o querés cargar?';
const HANDOFF_MSG     = 'Listo! En breve un operador humano te va a atender 👋';
const OUT_OF_HOURS_MSG = 'Hola! En este momento no hay operadores disponibles. Te respondemos en cuanto volvamos 🙏';

// ─── Image: full 4-step flow ──────────────────────────────────────────────────
// Step 1: GET graph.facebook.com/v18.0/{mediaId}?fields=url  → temporary download URL
// Step 2: GET that download URL with Bearer token             → image buffer
// Step 3: Upload buffer to Supabase Storage (service role)   → stored file
// Step 4: Construct permanent public URL manually             → saved to DB

async function saveComprobanteImage(mediaId: string, contactId: string): Promise<string | null> {
  const waToken  = process.env.WHATSAPP_ACCESS_TOKEN;
  const supaUrl  = process.env.NEXT_PUBLIC_SUPABASE_URL;

  if (!waToken) {
    console.error('[saveComprobanteImage] WHATSAPP_ACCESS_TOKEN no configurado');
    return null;
  }
  if (!supaUrl) {
    console.error('[saveComprobanteImage] NEXT_PUBLIC_SUPABASE_URL no configurado');
    return null;
  }

  // ── Step 1: resolve download URL from Graph API ──────────────────────────
  let downloadUrl: string;
  try {
    const metaRes = await axios.get(`https://graph.facebook.com/v18.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${waToken}` },
      params:  { fields: 'url' },
      timeout: 15000,
    });
    downloadUrl = metaRes.data?.url as string;
    if (!downloadUrl) throw new Error('Graph API no devolvió url en la respuesta');
    console.log(`[saveComprobanteImage] Step1 ✓ downloadUrl: ${downloadUrl.slice(0, 80)}`);
  } catch (err: any) {
    const detail = err?.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error(`[saveComprobanteImage] Step1 ✗ Error Graph API: ${detail}`);
    return null;
  }

  // ── Step 2: download image buffer with Bearer token ──────────────────────
  let buffer: Buffer;
  let contentType: string;
  try {
    const imgRes = await axios.get<ArrayBuffer>(downloadUrl, {
      responseType: 'arraybuffer',
      headers:      { Authorization: `Bearer ${waToken}` },
      timeout:      30000,
    });
    buffer      = Buffer.from(imgRes.data);
    contentType = (imgRes.headers['content-type'] as string) || 'image/jpeg';
    console.log(`[saveComprobanteImage] Step2 ✓ ${buffer.length} bytes, contentType=${contentType}`);
  } catch (err: any) {
    const detail = err?.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error(`[saveComprobanteImage] Step2 ✗ Error descargando imagen: ${detail}`);
    return null;
  }

  // ── Step 3: upload to Supabase Storage ───────────────────────────────────
  const ext      = contentType.includes('png') ? 'png'
                 : contentType.includes('webp') ? 'webp'
                 : contentType.includes('gif')  ? 'gif'
                 : 'jpg';
  const filePath = `${contactId}/${Date.now()}.${ext}`;

  console.log(`[saveComprobanteImage] Step3 uploading → comprobantes/${filePath}`);

  const { error: uploadError } = await supabaseAdmin.storage
    .from(COMPROBANTES_BUCKET)
    .upload(filePath, buffer, { contentType, upsert: true });

  if (uploadError) {
    console.error(`[saveComprobanteImage] Step3 ✗ Supabase Storage error: ${uploadError.message}`);
    return null;
  }

  console.log(`[saveComprobanteImage] Step3 ✓ archivo guardado en Storage`);

  // ── Step 4: build permanent public URL ───────────────────────────────────
  // Format: {SUPABASE_URL}/storage/v1/object/public/comprobantes/{filePath}
  const publicUrl = `${supaUrl}/storage/v1/object/public/${COMPROBANTES_BUCKET}/${filePath}`;
  console.log(`[saveComprobanteImage] Step4 ✓ publicUrl: ${publicUrl}`);
  return publicUrl;
}

// Sube la imagen a Storage y la guarda como comprobante (estado pendiente).
// Se llama SIEMPRE que entra una imagen/documento, sin importar el estado del bot.
async function persistComprobanteImage(message: any, contactId: string): Promise<void> {
  const mediaId = message.image?.id ?? message.document?.id ?? null;
  const supabaseImageUrl = mediaId ? await saveComprobanteImage(mediaId, contactId) : null;

  if (!mediaId)          console.warn('[image] Sin mediaId en el payload');
  if (!supabaseImageUrl) console.warn('[image] Upload falló — comprobante se guarda sin imagen');

  try {
    const { error } = await supabaseAdmin.from('comprobantes').insert({
      contact_id: contactId,
      image_url:  supabaseImageUrl,
      monto:      0,
      estado:     'pendiente',
    });
    if (error) console.error('[image] Error guardando comprobante en DB:', error.message);
    else       console.log('[image] Comprobante guardado OK');
  } catch (err) {
    console.error('[image] Excepción guardando comprobante:', err);
  }
}

// ─── Webhook entry ────────────────────────────────────────────────────────────

export async function handleWhatsappWebhook(
  rawBody: string,
  signature: string | undefined,
  payload: any,
) {
  if (!verifyMetaSignature(signature, rawBody)) {
    console.error('[webhook] Firma inválida — rechazando request');
    return { status: 401, body: 'Firma no valida' };
  }

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const message of change.value?.messages ?? []) {
        try {
          await processMessage(change.value?.metadata?.phone_number_id, message, change.value?.contacts?.[0]);
        } catch (err) {
          console.error('[webhook] Error no manejado en processMessage:', err);
        }
      }
    }
  }

  return { status: 200, body: 'EVENT_RECEIVED' };
}

// ─── Core message processor ───────────────────────────────────────────────────

async function processMessage(
  _phoneNumberId: string | undefined,
  message: any,
  contactMeta: any,
) {
  const messageId = message.id   as string | undefined;
  const from      = message.from as string | undefined;
  const type      = message.type as string;
  const text      = (message.text?.body ?? '').trim() as string;

  console.log(`[webhook] Entrante: from=${from} type=${type} text="${text.slice(0, 60)}"`);
  console.log(`[webhook] EnvCheck: TOKEN=${!!process.env.WHATSAPP_ACCESS_TOKEN} PHONE_ID=${!!process.env.WHATSAPP_PHONE_NUMBER_ID} SUPABASE=${!!process.env.SUPABASE_SERVICE_ROLE_KEY}`);

  if (!messageId || !from) {
    console.warn('[webhook] Mensaje sin id o from — ignorando');
    return;
  }

  // ── Deduplication ──────────────────────────────────────────────────────────
  try {
    const { data: dup } = await supabaseAdmin
      .from('messages')
      .select('id')
      .eq('whatsapp_message_id', messageId)
      .maybeSingle();
    if (dup) {
      console.log(`[webhook] Duplicado detectado para messageId=${messageId} — ignorando`);
      return;
    }
  } catch {
    // If whatsapp_message_id column doesn't exist, skip dedup and continue
  }

  // ── Contact ────────────────────────────────────────────────────────────────
  const { contact, isNew } = await findOrCreateContact(from, contactMeta?.profile?.name ?? null);
  if (!contact) {
    console.error('[webhook] No se pudo crear/obtener contacto para', from);
    return;
  }
  console.log(`[webhook] Contact: id=${contact.id} phone=${contact.phone} isNew=${isNew} status=${contact.status} conversation_state=${contact.conversation_state ?? 'null'}`);

  // ── Save user message ──────────────────────────────────────────────────────
  try {
    const { error } = await supabaseAdmin.from('messages').insert({
      contact_id:          contact.id,
      role:                'user',
      content:             type === 'text' ? text : type,
      whatsapp_message_id: messageId,
      type,
    });
    if (error) {
      console.warn('[webhook] Insert mensaje usuario falló:', error.message, '— reintentando sin campos opcionales');
      // Retry without fields that might not exist in the schema
      const { error: err2 } = await supabaseAdmin.from('messages').insert({
        contact_id: contact.id,
        role:       'user',
        content:    type === 'text' ? text : type,
      });
      if (err2) console.error('[webhook] Retry insert también falló:', err2.message);
    }
  } catch (err) {
    console.error('[webhook] Error inesperado guardando mensaje usuario:', err);
  }

  // ── Bot enabled check ──────────────────────────────────────────────────────
  const botEnabled = await getBotEnabled();
  console.log(
    `[webhook] bot_enabled=${botEnabled} | contact.id=${contact.id}` +
    ` status=${contact.status} conversation_state=${contact.conversation_state ?? 'null'}`,
  );

  // ── Reply helper ───────────────────────────────────────────────────────────
  async function replyAndSave(
    textResp: string,
    opts: { newState?: string | null; markInProgress?: boolean } = {},
  ) {
    console.log(`[replyAndSave] → "${textResp.slice(0, 60)}" opts=${JSON.stringify(opts)}`);

    // 1. Save to DB
    let dbInsertOk = false;
    let insertedId: string | null = null;
    try {
      const { data: inserted, error } = await supabaseAdmin
        .from('messages')
        .insert({ contact_id: contact.id, role: 'assistant', content: textResp })
        .select('id')
        .single();
      if (error) {
        console.error('[replyAndSave] DB insert error:', error.message);
      } else {
        dbInsertOk  = true;
        insertedId  = inserted?.id ?? null;
      }
    } catch (err) {
      console.error('[replyAndSave] DB insert excepción:', err);
    }

    // 2. Send via WhatsApp API — always attempt regardless of DB result
    try {
      await sendWhatsAppText(from!, textResp);
      if (dbInsertOk && insertedId) {
        await supabaseAdmin.from('messages').update({ status: 'sent' }).eq('id', insertedId);
      }
    } catch (err) {
      console.error('[replyAndSave] WhatsApp send error — mensaje NO llegó al usuario');
      if (dbInsertOk && insertedId) {
        await supabaseAdmin.from('messages').update({ status: 'failed' }).eq('id', insertedId);
      }
    }

    // 3. Update contact state
    // Two-step: status first (column always exists), then conversation_state separately.
    // This ensures en_proceso is always set even if conversation_state column is missing.
    try {
      if (opts.markInProgress) {
        const { error: stErr } = await supabaseAdmin
          .from('contacts').update({ status: 'en_proceso' }).eq('id', contact.id);
        if (stErr) console.warn('[replyAndSave] status update error:', stErr.message);
        else       console.log('[replyAndSave] contact.status → en_proceso');
      }

      const stateUpdate: Record<string, any> = {};
      if ('newState' in opts)  stateUpdate.conversation_state = opts.newState ?? null;
      if (opts.markInProgress) stateUpdate.conversation_state = 'done';

      if (Object.keys(stateUpdate).length > 0) {
        const { error: csErr } = await supabaseAdmin
          .from('contacts').update(stateUpdate).eq('id', contact.id);
        if (csErr) console.warn('[replyAndSave] conversation_state update error (columna puede no existir):', csErr.message);
      }
    } catch (err) {
      console.error('[replyAndSave] Contact update excepción:', err);
    }
  }

  // ─── Comprobantes: SIEMPRE se guardan (el operador los necesita) ──────────
  // Independiente del bot: aunque el contacto sea preexistente o el bot esté
  // apagado, la imagen se persiste como comprobante.
  if (type === 'image' || type === 'document') {
    await persistComprobanteImage(message, contact.id);
  }

  // ── Kill switch global del bot ──────────────────────────────────────────
  if (!botEnabled) {
    console.log('[bot] bot_enabled=false — sin respuesta automática');
    return;
  }

  // ── Contacto bloqueado → silencio total ─────────────────────────────────
  if (contact.blocked) {
    console.log('[bot] Contacto bloqueado — sin respuesta');
    return;
  }

  // ── FUERA DE HORARIO (aplica a TODOS) ───────────────────────────────────
  // Si no hay ningún operador activo dentro de su horario, se avisa y se corta.
  if (!(await hasActiveOperator())) {
    console.log('[bot] Sin operadores en horario — enviando aviso fuera de horario');
    await replyAndSave(OUT_OF_HOURS_MSG);
    return;
  }

  // ── REGLA PRINCIPAL: el bot SOLO atiende números nuevos/desconocidos ─────
  // "Bot-owned" = recién creado en este mensaje (isNew), o ya está en un
  // onboarding que el propio bot inició (conversation_state ∈ BOT_FLOW_STATES).
  // Cualquier contacto que YA existía antes de este mensaje (importado, cliente,
  // etc.) va directo a la cola del operador, SIN importar su status.
  const inBotFlow = BOT_FLOW_STATES.has((contact.conversation_state as string | null) ?? '');
  if (!isNew && !inBotFlow) {
    console.log('[bot] Contacto preexistente → cola del operador, sin respuesta del bot');
    return;
  }

  // ─── A partir de acá: contacto nuevo o en onboarding iniciado por el bot ──

  // ─── IMAGE / DOCUMENT (en flujo) ──────────────────────────────────────────
  if (type === 'image' || type === 'document') {
    const imgState = (contact.conversation_state as string | null) ?? null;
    if (imgState === 'waiting_screenshot') {
      console.log('[image] Es captura del canal → continuando flujo de onboarding');
      await replyAndSave('Buenisimo! Sos de cargar y jugar seguido?', { newState: 'asked_if_loader' });
    } else {
      console.log(`[image] Comprobante en flujo (state="${imgState}") → acuse de recibo`);
      await replyAndSave('Comprobante recibido ✅ Un operador lo verifica enseguida.');
    }
    return;
  }

  // ─── AUDIO / VOICE / VIDEO / STICKER ─────────────────────────────────────
  if (['audio', 'voice', 'video', 'sticker'].includes(type)) {
    console.log(`[bot] Tipo no-texto: ${type} — respondiendo con mensaje de texto`);
    await replyAndSave('Soy Iris, asistente virtual 🤖 No puedo escuchar audios ni ver stickers, escribime por texto 😊');
    return;
  }

  // ─── STATE MACHINE ────────────────────────────────────────────────────────
  const state     = contact.conversation_state as string | null ?? null;
  const lowerText = text.toLowerCase();
  console.log(`[bot] state="${state}" text="${text.slice(0, 60)}"`);

  switch (state) {
    // ── Contacto nuevo: bienvenida + primera pregunta ─────────────────────────
    case null:
    case 'greeting': {
      await replyAndSave(WELCOME_MSG, { newState: 'asked_intention' });
      break;
    }

    // ── User chose fichas or cargar ───────────────────────────────────────────
    case 'asked_intention': {
      if (/carg(ar|a)|quiero cargar|quiero recarg/.test(lowerText)) {
        await replyAndSave(HANDOFF_MSG, { markInProgress: true });
      } else if (/fichas|prueba|proba|prueb/.test(lowerText)) {
        await replyAndSave(
          'Unite a mi canal de WhatsApp y mandame la captura. Ahí subo promos, horarios y lineas disponibles 👉 https://whatsapp.com/channel/0029VbCHhpyGOj9me9y9pF3F',
          { newState: 'waiting_screenshot' },
        );
      } else {
        await replyAndSave('¿Venís por las fichas de prueba o querés cargar?');
      }
      break;
    }

    // ── Waiting for channel screenshot (text message) ─────────────────────────
    case 'waiting_screenshot': {
      if (/no puedo|no puedo mandar|no puedo enviar|no puedo subir/.test(lowerText)) {
        await replyAndSave(HANDOFF_MSG, { markInProgress: true });
      } else {
        await replyAndSave(
          'Necesito que me mandes la captura del canal de WhatsApp para poder continuar. Si no podés, avisame.',
        );
      }
      break;
    }

    // ── After receiving image, asked if they load ─────────────────────────────
    case 'asked_if_loader': {
      if (/(^si$|^sí$|si!|sí!|obvio|claro|siempre|dale|ofc|por supuesto)/.test(lowerText)) {
        await replyAndSave(
          'Buenisimo! Estoy buscando clientes que carguen conmigo 💪 Las fichas de regalo son solo para probar la plataforma. Los premios se retiran cuando jugás con una carga. Si estás de acuerdo, decime tu nombre y te creo el usuario. Además te doy un 20% extra en tu primera carga 🔥',
          { newState: 'asked_name' },
        );
      } else if (/(^no$|nono|no gracias|no quiero|paso)/.test(lowerText)) {
        await replyAndSave(HANDOFF_MSG, { markInProgress: true });
      } else {
        await replyAndSave('Sos de cargar y jugar seguido? Respondé si o no 😊');
      }
      break;
    }

    // ── Fin del onboarding → handoff al operador ──────────────────────────────
    case 'asked_name': {
      // El nombre lo asigna el operador desde el CRM; el bot no lo escribe.
      await replyAndSave(HANDOFF_MSG, { markInProgress: true });
      break;
    }

    // ── Estado no mapeado (no debería ocurrir en bot-owned) → handoff seguro ──
    case 'done':
    default: {
      console.warn(`[bot] Estado no mapeado: "${state}" — handoff al operador`);
      await replyAndSave(HANDOFF_MSG, { markInProgress: true });
      break;
    }
  }
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

const CONTACT_COLS =
  'id, phone, name, status, casino_username, conversation_state, last_read_at, blocked';

// Extracts the national significant number (area code + subscriber) so numbers
// stored in different formats still match. WhatsApp sends AR mobiles as
// 549XXXXXXXXXX (no '+'), while contacts may be saved as 54XXXXXXXXXX (no 9),
// +549XXXXXXXXXX, or just the area+number. Stripping country code 54 and the
// mobile '9' yields a stable ~10-digit core we can suffix-match on.
function phoneCore(raw: string): string {
  let d = (raw ?? '').replace(/\D/g, '');
  if (d.startsWith('54')) d = d.slice(2);
  if (d.startsWith('9') && d.length > 10) d = d.slice(1);
  return d;
}

// Devuelve { contact, isNew }. isNew=true SOLO cuando el contacto fue creado
// en esta llamada (número completamente desconocido). Un match exacto o flexible
// → isNew=false (el número ya existía, en cualquier formato).
async function findOrCreateContact(
  phone: string,
  _whatsappName: string | null,
): Promise<{ contact: any | null; isNew: boolean }> {
  // _whatsappName is intentionally ignored — bot never writes name to contacts.
  // Explicit column list avoids PostgREST schema-cache issues with recently added columns.
  try {
    // 1. Exact match (fast path).
    const { data: exact } = await supabaseAdmin
      .from('contacts')
      .select(CONTACT_COLS)
      .eq('phone', phone)
      .limit(1)
      .maybeSingle();

    if (exact) {
      return { contact: exact, isNew: false };
    }

    // 2. Flexible match by normalized core — catches contacts saved in a
    //    different phone format (with '+', no country code, AR '9', etc.).
    //    Without this they'd be re-created as nameless "unknown" contacts.
    const core = phoneCore(phone);
    if (core.length >= 8) {
      const { data: fuzzy } = await supabaseAdmin
        .from('contacts')
        .select(CONTACT_COLS)
        .ilike('phone', `%${core}`)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();

      if (fuzzy) {
        console.log(
          `[findOrCreateContact] Match flexible: from="${phone}" → contacto existente ` +
          `phone="${fuzzy.phone}" name=${JSON.stringify(fuzzy.name ?? null)}`,
        );
        return { contact: fuzzy, isNew: false };
      }
    }

    // 3. No match anywhere → create new contact.
    const provincia = inferProvinciaFromPhone(phone);
    const { data: inserted, error } = await supabaseAdmin
      .from('contacts')
      .insert({ phone, name: null, status: 'nuevo', ...(provincia ? { provincia } : {}) })
      .select('*')
      .single();

    if (error) {
      console.error('[findOrCreateContact] Insert error:', error.message);
      // Race condition: otro proceso lo creó en paralelo → existía, isNew=false.
      const { data: retry } = await supabaseAdmin
        .from('contacts').select('*').eq('phone', phone).limit(1).maybeSingle();
      return { contact: retry ?? null, isNew: false };
    }

    return { contact: inserted, isNew: true };
  } catch (err) {
    console.error('[findOrCreateContact] Excepción:', err);
    return { contact: null, isNew: false };
  }
}

// "HH:MM[:SS]" → minutos desde medianoche. null si no hay horario.
function timeToMinutes(t: string | null | undefined): number | null {
  if (!t) return null;
  const [h, m] = String(t).split(':');
  const hh = Number(h), mm = Number(m ?? 0);
  if (Number.isNaN(hh)) return null;
  return hh * 60 + mm;
}

// ¿Hay al menos un operador activo dentro de su horario AHORA (hora Argentina)?
// Un agente activo sin horario definido cuenta como disponible 24h.
// Fail-open: ante error o sin agentes, asume que hay operadores (no manda el
// aviso de fuera de horario por las dudas).
async function hasActiveOperator(): Promise<boolean> {
  try {
    const { data: agents, error } = await supabaseAdmin
      .from('agents')
      .select('active, schedule_start, schedule_end');

    if (error) { console.warn('[hasActiveOperator] Error leyendo agents:', error.message); return true; }
    if (!agents || agents.length === 0) return true;

    // Argentina es UTC-3 fijo.
    const arg    = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const nowMin = arg.getUTCHours() * 60 + arg.getUTCMinutes();

    for (const a of agents) {
      if (!a.active) continue;
      const s = timeToMinutes(a.schedule_start);
      const e = timeToMinutes(a.schedule_end);
      if (s === null || e === null) return true; // activo sin horario → disponible 24h
      // Horario normal (s<=e) o que cruza medianoche (s>e).
      const within = s <= e ? (nowMin >= s && nowMin <= e) : (nowMin >= s || nowMin <= e);
      if (within) return true;
    }
    return false;
  } catch (err) {
    console.warn('[hasActiveOperator] Excepción:', err);
    return true; // fail open
  }
}

async function getBotEnabled(): Promise<boolean> {
  try {
    // Read ALL possible key formats for bot control
    const { data: rows, error } = await supabaseAdmin
      .from('settings')
      .select('key, value')
      .in('key', [BOT_ENABLED_KEY, 'bot_mode'])
      .limit(10);

    if (error) {
      console.error('[getBotEnabled] Error leyendo settings:', error.message);
      return true; // fail open
    }

    const map: Record<string, string> = {};
    for (const row of rows ?? []) map[row.key] = row.value;

    console.log('[getBotEnabled] settings encontrados:', JSON.stringify(map));

    // Priority 1: bot_enabled (our canonical key)
    if ('bot_enabled' in map) {
      const raw     = map.bot_enabled;
      const enabled = raw !== 'false' && raw !== false as any;
      console.log(`[getBotEnabled] via bot_enabled="${raw}" → enabled=${enabled}`);
      return enabled;
    }

    // Priority 2: bot_mode (alternative format, 'bot'=enabled, 'human'=disabled)
    if ('bot_mode' in map) {
      const raw     = map.bot_mode;
      const enabled = raw === 'bot' || raw === 'true';
      console.log(`[getBotEnabled] via bot_mode="${raw}" → enabled=${enabled}`);
      return enabled;
    }

    console.log('[getBotEnabled] Sin fila en settings → default enabled=true');
    return true;
  } catch (err) {
    console.error('[getBotEnabled] Excepción:', err);
    return true; // fail open
  }
}
