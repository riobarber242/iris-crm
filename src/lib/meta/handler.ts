import axios from 'axios';
import { verifyMetaSignature } from './verify';
import { sendWhatsAppText } from './client';
import { supabaseAdmin } from '../db';
import { irisSystemPrompt } from '../system-prompt';
import { inferProvinciaFromPhone } from '../phone-province';
import { decideBotResponse } from './bot-decision';
import { notifyContactAgents } from '../push';
import { generateBotResponse } from '../groq';

// Resuelve el system prompt para Groq con esta prioridad:
//   1. system_prompt del operador asignado al contacto (si no está vacío)
//   2. system_prompt global guardado en settings
//   3. irisSystemPrompt hardcodeado
// `assignedAgentId` es contacts.assigned_agent_id del contacto activo.
async function getSystemPrompt(assignedAgentId?: string | null): Promise<string> {
  // 1. Prompt por operador (agente asignado).
  if (assignedAgentId) {
    try {
      const { data: agent } = await supabaseAdmin
        .from('agents').select('system_prompt').eq('id', assignedAgentId).maybeSingle();
      const perAgent = (agent?.system_prompt ?? '').trim();
      if (perAgent) return perAgent;
    } catch {
      // si falla, caemos al prompt global / default
    }
  }

  // 2. Prompt global (settings) → 3. default hardcodeado.
  try {
    const { data } = await supabaseAdmin
      .from('settings').select('value').eq('key', 'system_prompt').limit(1).maybeSingle();
    return data?.value ?? irisSystemPrompt;
  } catch {
    return irisSystemPrompt;
  }
}

// Híbrido acotado: cuando el usuario contesta algo fuera de guion en un estado del
// onboarding, intenta una respuesta natural con Groq usando el prompt del operador
// asignado, reencauzando hacia el objetivo del estado. Si Groq no está configurado
// o falla, devuelve null y el caller usa el mensaje hardcodeado de siempre.
async function aiSteerReply(
  stateGoal: string,
  userText: string,
  assignedAgentId: string | null,
): Promise<string | null> {
  if (!process.env.GROQ_API_KEY) return null;        // sin Groq → guion hardcodeado
  if (!userText.trim()) return null;
  try {
    const base = await getSystemPrompt(assignedAgentId);
    const systemPrompt =
      `${base}\n\nContexto: estás en el onboarding por WhatsApp y el usuario respondió ` +
      `algo fuera de lo esperado. Objetivo actual: ${stateGoal}. Respondé en UNA sola frase ` +
      `breve (máx 25 palabras), amable, en español argentino con voseo, y reencauzá la charla ` +
      `hacia ese objetivo. No inventes datos ni precios.`;
    const reply = (await generateBotResponse(systemPrompt, userText))?.trim();
    return reply || null;
  } catch (err) {
    console.warn('[bot] aiSteerReply falló, uso guion:', err);
    return null;
  }
}

const COMPROBANTES_BUCKET = 'comprobantes';
const BOT_ENABLED_KEY     = 'bot_enabled';

// Mensajes del bot.
const WELCOME_MSG     = '¡Hola! Soy Iris, asistente virtual 🤖 Para orientarte mejor necesito hacerte un par de preguntas. ¿Es tu primera vez con nosotros o ya tenés cuenta?';
const HANDOFF_MSG     = '¡Listo! Un operador humano te va a atender en breve 👋';
const OUT_OF_HOURS_MSG = 'Hola! En este momento no hay operadores disponibles. Te respondemos en cuanto volvamos 🙏';
const OFFLINE_MSG         = 'Hola! En este momento no estamos operando. Volvemos pronto 🙏';
const OFFLINE_HANDOFF_MSG = 'En este momento no hay operadores disponibles. Te respondemos cuando volvamos 🙏';

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
// Sube la imagen a Storage, la guarda como comprobante y devuelve la URL pública
// (o null si no se pudo). Se llama SIEMPRE que entra una imagen/documento.
async function persistComprobanteImage(message: any, contactId: string): Promise<string | null> {
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

  return supabaseImageUrl;
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
      // Webhooks de status (ticks): sent / delivered / read / failed.
      for (const status of change.value?.statuses ?? []) {
        try {
          await processStatus(status);
        } catch (err) {
          console.error('[webhook] Error no manejado en processStatus:', err);
        }
      }
    }
  }

  return { status: 200, body: 'EVENT_RECEIVED' };
}

// Actualiza el status de un mensaje saliente según el webhook de WhatsApp,
// matcheando por wamid (whatsapp_message_id). Para los ticks del CRM.
async function processStatus(status: any) {
  const wamid   = status?.id as string | undefined;
  const newStat = status?.status as string | undefined; // sent | delivered | read | failed
  if (!wamid || !newStat) return;
  if (!['sent', 'delivered', 'read', 'failed'].includes(newStat)) return;

  const { error } = await supabaseAdmin
    .from('messages')
    .update({ status: newStat })
    .eq('whatsapp_message_id', wamid);
  if (error) console.warn(`[status] No se pudo actualizar status=${newStat} wamid=${wamid}:`, error.message);
  else       console.log(`[status] wamid=${wamid} → ${newStat}`);
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

  // ── Reacción entrante del cliente ───────────────────────────────────────────
  // Se aplica como badge sobre el mensaje original (matcheado por wamid). NO se
  // guarda como burbuja de texto ni dispara el bot. emoji vacío = quitó la reacción.
  if (type === 'reaction') {
    const targetWamid = message.reaction?.message_id as string | undefined;
    const emoji       = (message.reaction?.emoji ?? '') as string;
    console.log(`[webhook] Reacción entrante: target=${targetWamid} emoji="${emoji}"`);
    if (targetWamid) {
      try {
        const { error } = await supabaseAdmin
          .from('messages').update({ reaction: emoji || null }).eq('whatsapp_message_id', targetWamid);
        if (error) console.warn('[webhook] No se pudo guardar reacción entrante (¿falta columna?):', error.message);
      } catch (err) {
        console.error('[webhook] Excepción guardando reacción entrante:', err);
      }
    }
    return;
  }

  // ── Contact ────────────────────────────────────────────────────────────────
  const { contact, isNew } = await findOrCreateContact(from, contactMeta?.profile?.name ?? null);
  if (!contact) {
    console.error('[webhook] No se pudo crear/obtener contacto para', from);
    return;
  }
  console.log(`[webhook] Contact: id=${contact.id} phone=${contact.phone} isNew=${isNew} status=${contact.status} conversation_state=${contact.conversation_state ?? 'null'}`);

  // ── Comprobantes/imágenes: subir ANTES de guardar el mensaje, para que el
  //    mensaje entrante de tipo image se guarde como media (no como texto "image")
  //    y se renderice como imagen en el chat del CRM. La imagen también se guarda
  //    como comprobante (operador la necesita).
  let inboundImageUrl: string | null = null;
  if (type === 'image' || type === 'document') {
    inboundImageUrl = await persistComprobanteImage(message, contact.id);
  }

  // Contenido del mensaje del usuario.
  const userContent =
    type === 'text'                          ? text
    : (type === 'image' && inboundImageUrl)  ? JSON.stringify({ _type: 'image', url: inboundImageUrl, caption: (message.image?.caption ?? '').trim() })
    : type;

  // ── Save user message ──────────────────────────────────────────────────────
  try {
    const { error } = await supabaseAdmin.from('messages').insert({
      contact_id:          contact.id,
      role:                'user',
      content:             userContent,
      whatsapp_message_id: messageId,
      type,
    });
    if (error) {
      console.warn('[webhook] Insert mensaje usuario falló:', error.message, '— reintentando sin campos opcionales');
      // Retry without fields that might not exist in the schema
      const { error: err2 } = await supabaseAdmin.from('messages').insert({
        contact_id:          contact.id,
        role:                'user',
        content:             userContent,
        whatsapp_message_id: messageId,
      });
      if (err2) console.error('[webhook] Retry insert también falló:', err2.message);
    }
  } catch (err) {
    console.error('[webhook] Error inesperado guardando mensaje usuario:', err);
  }

  // ── Push a los operadores: avisar que entró un mensaje de cliente ───────────
  // Best-effort: nunca debe romper el flujo del bot si el push falla.
  try {
    const preview =
      type === 'text'                ? text
      : type === 'image'             ? '📷 Imagen'
      : type === 'document'          ? '📄 Documento'
      : ['audio', 'voice'].includes(type) ? '🎤 Audio'
      : type;
    await notifyContactAgents(contact.assigned_agent_id ?? null, {
      title: 'IRIS',
      body: `${contact.name || contact.phone}: ${String(preview).slice(0, 120)}`,
      url: `/conversations/${contact.id}`,
    });
  } catch (err) {
    console.warn('[webhook] notifyContactAgents falló (ignorado):', err);
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
      const wamid = await sendWhatsAppText(from!, textResp);
      if (dbInsertOk && insertedId) {
        await supabaseAdmin.from('messages')
          .update({ status: 'sent', whatsapp_message_id: wamid })
          .eq('id', insertedId);
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

  // (La imagen/comprobante ya se subió y guardó arriba, antes de guardar el mensaje.)

  // ── MODO OFFLINE ─────────────────────────────────────────────────────────
  // · OFFLINE + bot APAGADO → aviso directo a todos, sin flujo.
  // · OFFLINE + bot PRENDIDO → onboarding normal, pero el mensaje de cierre
  //   (handoff) cambia al aviso de "no hay operadores" (ver handoffMsg). El bot
  //   sigue trabajando igual; solo cambia el cierre.
  const offline = await getOfflineMode();
  if (offline) {
    console.log('[bot] OFFLINE — aviso directo a todos');
    if (!contact.blocked) await replyAndSave(OFFLINE_MSG);
    return;
  }

  // ── Cliente ya reconocido (fast path, ANTES de cualquier flujo) ─────────────
  // Si el número ya existe en contacts con casino_username y está en el punto de
  // entrada (contacto nuevo o conversation_state nulo), NO se onboardea: se lo
  // saluda por su usuario y queda listo para atención humana. El estado
  // 'known_client' hace que classifyPending lo marque ROJO mientras esté online.
  // (Un contacto nuevo nunca trae casino_username, así que en la práctica esto
  // aplica a números preexistentes que recién escriben.)
  const atEntryPoint = isNew || (contact.conversation_state ?? null) === null;
  if (atEntryPoint && botEnabled && !contact.blocked && contact.casino_username) {
    console.log(`[bot] Cliente reconocido (${contact.casino_username}) → known_client, sin onboarding`);
    await replyAndSave(
      `¡Hola ${contact.casino_username}! Ya te reconocemos, en un momento te atendemos 👋`,
      { newState: 'known_client' },
    );
    return;
  }

  // Mensaje de cierre del onboarding (handoff): cambia si estamos offline.
  const handoffMsg = offline ? OFFLINE_HANDOFF_MSG : HANDOFF_MSG;

  // ── Decisión del bot (regla principal + horario) ─────────────────────────
  // Lógica pura en bot-decision.ts (testeable). Resumen:
  //  · bot apagado / bloqueado            → silencio
  //  · contacto preexistente              → silencio (cola del operador)
  //  · número nuevo fuera de horario      → aviso "no hay operadores" (una vez)
  //  · onboarding en curso fuera de hora  → silencio (no se onboardea de noche)
  //  · resto (atiende el bot, en horario) → seguir el flujo
  // En OFFLINE el bot atiende igual el onboarding (no se aplica el corte por
  // horario), y el cierre usa handoffMsg.
  const operatorAvailable = offline ? true : await hasActiveOperator();
  const decision = decideBotResponse({
    botEnabled,
    blocked: !!contact.blocked,
    isNew,
    conversationState: (contact.conversation_state as string | null) ?? null,
    operatorAvailable,
  });
  console.log(`[bot] decisión=${JSON.stringify(decision)} isNew=${isNew} state=${contact.conversation_state ?? 'null'} operador=${operatorAvailable}`);

  if (decision.action === 'silent') return;
  if (decision.action === 'out_of_hours') {
    await replyAndSave(OUT_OF_HOURS_MSG);
    return;
  }
  // decision.action === 'flow' → continúa con image-in-flow / audio / state machine

  // ─── A partir de acá: contacto nuevo o en onboarding iniciado por el bot ──

  // ─── IMAGE / DOCUMENT (en flujo) ──────────────────────────────────────────
  if (type === 'image' || type === 'document') {
    const imgState = (contact.conversation_state as string | null) ?? null;
    if (imgState === 'waiting_screenshot') {
      console.log('[image] Es captura del canal → continuando flujo de onboarding');
      await replyAndSave('Buenisimo! Sos de recargar seguido?', { newState: 'asked_if_loader' });
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

    // ── ¿Primera vez o ya tiene cuenta? ───────────────────────────────────────
    case 'asked_intention': {
      if (/ya teng|ya ten[eé]s|tengo cuenta|tengo una cuenta|ya soy|tengo usuario/.test(lowerText)) {
        // Ya tiene cuenta → lo atiende un operador.
        await replyAndSave(handoffMsg, { markInProgress: true });
      } else if (/primera|primer|nuev[oa]|reci[eé]n|no teng|empez|arranco|soy nuevo/.test(lowerText)) {
        // Primera vez → onboarding.
        await replyAndSave(
          'Unite a mi canal de WhatsApp y mandame la captura. Ahí subo promos, horarios y novedades 👉 https://whatsapp.com/channel/0029VbCHhpyGOj9me9y9pF3F',
          { newState: 'waiting_screenshot' },
        );
      } else {
        const ai = await aiSteerReply(
          'que el usuario aclare si es su primera vez o si ya tiene cuenta',
          text, contact.assigned_agent_id ?? null,
        );
        await replyAndSave(ai ?? '¿Es tu primera vez con nosotros o ya tenés cuenta?');
      }
      break;
    }

    // ── Waiting for channel screenshot (text message) ─────────────────────────
    case 'waiting_screenshot': {
      if (/no puedo|no puedo mandar|no puedo enviar|no puedo subir/.test(lowerText)) {
        await replyAndSave(handoffMsg, { markInProgress: true });
      } else {
        const ai = await aiSteerReply(
          'que el usuario mande la captura del canal de WhatsApp para poder continuar',
          text, contact.assigned_agent_id ?? null,
        );
        await replyAndSave(
          ai ?? 'Necesito que me mandes la captura del canal de WhatsApp para poder continuar. Si no podés, avisame.',
        );
      }
      break;
    }

    // ── After receiving image, asked if they load ─────────────────────────────
    case 'asked_if_loader': {
      if (/(^si$|^sí$|si!|sí!|obvio|claro|siempre|dale|ofc|por supuesto)/.test(lowerText)) {
        await replyAndSave(
          'Buenisimo! Estoy buscando clientes que recarguen conmigo 💪 El saldo de regalo es solo para probar la plataforma. Los premios se retiran cuando usás una recarga. Si estás de acuerdo, decime tu nombre y te creo la cuenta. Además te doy un 20% extra en tu primera recarga 🔥',
          { newState: 'asked_name' },
        );
      } else if (/(^no$|nono|no gracias|no quiero|paso)/.test(lowerText)) {
        await replyAndSave(handoffMsg, { markInProgress: true });
      } else {
        const ai = await aiSteerReply(
          'que el usuario responda si recarga seguido (sí o no)',
          text, contact.assigned_agent_id ?? null,
        );
        await replyAndSave(ai ?? 'Sos de recargar seguido? Respondé si o no 😊');
      }
      break;
    }

    // ── Fin del onboarding → handoff al operador ──────────────────────────────
    case 'asked_name': {
      // El nombre lo asigna el operador desde el CRM; el bot no lo escribe.
      await replyAndSave(handoffMsg, { markInProgress: true });
      break;
    }

    // ── Estado no mapeado (no debería ocurrir en bot-owned) → handoff seguro ──
    case 'done':
    default: {
      console.warn(`[bot] Estado no mapeado: "${state}" — handoff al operador`);
      await replyAndSave(handoffMsg, { markInProgress: true });
      break;
    }
  }
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

const CONTACT_COLS =
  'id, phone, name, status, casino_username, conversation_state, last_read_at, blocked, assigned_agent_id';

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

// Modo OFFLINE: si está activo, el bot solo manda el aviso de "no operamos".
// Default false (fail-closed: ante error NO se asume offline).
async function getOfflineMode(): Promise<boolean> {
  try {
    const { data, error } = await supabaseAdmin
      .from('settings').select('value').eq('key', 'offline_mode').limit(1).maybeSingle();
    if (error) { console.warn('[getOfflineMode] Error leyendo settings:', error.message); return false; }
    return data?.value === 'true';
  } catch (err) {
    console.warn('[getOfflineMode] Excepción:', err);
    return false;
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
