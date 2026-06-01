import axios from 'axios';
import { verifyMetaSignature } from './verify';
import { sendWhatsAppText } from './client';
import { supabaseAdmin } from '../db';

const COMPROBANTES_BUCKET = 'comprobantes';
const BOT_ENABLED_KEY     = 'bot_enabled';

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
  const contact = await findOrCreateContact(from, contactMeta?.profile?.name ?? null);
  if (!contact) {
    console.error('[webhook] No se pudo crear/obtener contacto para', from);
    return;
  }

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

  // ─── IMAGE / DOCUMENT ─────────────────────────────────────────────────────
  if (type === 'image' || type === 'document') {
    const mediaId = message.image?.id ?? message.document?.id ?? null;
    const imgState = contact.conversation_state as string | null ?? null;
    console.log(`[image] Procesando: type=${type} mediaId=${mediaId} conversation_state=${imgState}`);

    // Upload to Supabase Storage (4-step flow)
    const supabaseImageUrl = mediaId
      ? await saveComprobanteImage(mediaId, contact.id)
      : null;

    if (!mediaId)          console.warn('[image] Sin mediaId en el payload');
    if (!supabaseImageUrl) console.warn('[image] Upload falló — comprobante se guarda sin imagen');

    // Save comprobante regardless of which flow we're in
    try {
      const { error } = await supabaseAdmin.from('comprobantes').insert({
        contact_id: contact.id,
        image_url:  supabaseImageUrl,
        monto:      0,
        estado:     'pendiente',
      });
      if (error) console.error('[image] Error guardando comprobante en DB:', error.message);
      else       console.log('[image] Comprobante guardado OK');
    } catch (err) {
      console.error('[image] Excepción guardando comprobante:', err);
    }

    if (!botEnabled) return;

    // Decide response based on conversation state:
    // 'waiting_screenshot' → image is the channel screenshot → continue onboarding flow
    // anything else        → image is a payment receipt → acknowledge and stop
    if (imgState === 'waiting_screenshot') {
      console.log('[image] Es captura del canal → continuando flujo de onboarding');
      await replyAndSave('Buenisimo! Sos de cargar y jugar seguido?', { newState: 'asked_if_loader' });
    } else {
      console.log(`[image] Es comprobante de pago (state="${imgState}") → acuse de recibo`);
      await replyAndSave('Comprobante recibido ✅ Un operador lo verifica enseguida.');
    }
    return;
  }

  // ─── TEXT MESSAGES ────────────────────────────────────────────────────────
  if (!botEnabled) {
    console.log('[bot] bot_enabled=false — sin respuesta automática');
    return;
  }

  // ── COMPLETED CHECK (MUST be before isGreeting) ──────────────────────────
  // conversation_state 'done'/'en_proceso' OR status 'en_proceso' → silent.
  // No greeting reset, no response — only save the message (already done above).
  const textState  = contact.conversation_state as string | null ?? null;
  const isCompleted = textState === 'done'
                   || textState === 'en_proceso'
                   || contact.status === 'en_proceso';

  if (isCompleted) {
    console.log(`[bot] Flujo completado — state="${textState}" status="${contact.status}" — mensaje guardado sin respuesta`);
    return;
  }

  // GREETING RESET — only for contacts still in an active flow state
  const isGreeting = /^(hola|buenas|hey|buen\s*d[ií]a|buenos\s*d[ií]as|buenas\s*tardes|buenas\s*noches|ola|hi|hello|saludos|que\s*tal|como\s*estas|buenos)[!¡.,\s]*/i.test(text.trim());

  if (isGreeting) {
    console.log(`[bot] Saludo en flujo activo — reseteando (state="${textState}")`);
    await replyAndSave(
      'Buenas 🙌 mi nombre es Iris, agendame para poder seguir con la conversacion',
      { newState: 'greeting' },
    );
    return;
  }

  // ─── STATE MACHINE ────────────────────────────────────────────────────────
  const state     = contact.conversation_state as string | null ?? null;
  const lowerText = text.toLowerCase();
  console.log(`[bot] state="${state}" text="${text.slice(0, 60)}"`);

  switch (state) {
    // ── No state / after initial greeting ────────────────────────────────────
    case null:
    case 'greeting': {
      await replyAndSave('Venis por las fichas de prueba o queres cargar?', {
        newState: 'asked_intention',
      });
      break;
    }

    // ── User chose fichas or cargar ───────────────────────────────────────────
    case 'asked_intention': {
      if (/carg(ar|a)|quiero cargar|quiero recarg/.test(lowerText)) {
        await replyAndSave(
          'Perfecto! Un operador te va a atender enseguida para ayudarte con la carga 🙌',
          { markInProgress: true },
        );
      } else if (/fichas|prueba|proba|prueb/.test(lowerText)) {
        await replyAndSave(
          'Unite a mi canal de WhatsApp y mandame la captura. Ahí subo promos, horarios y lineas disponibles 👉 https://whatsapp.com/channel/0029VbCHhpyGOj9me9y9pF3F',
          { newState: 'waiting_screenshot' },
        );
      } else {
        await replyAndSave('Venis por las fichas de prueba o queres cargar?');
      }
      break;
    }

    // ── Waiting for channel screenshot (text message) ─────────────────────────
    case 'waiting_screenshot': {
      if (/no puedo|no puedo mandar|no puedo enviar|no puedo subir/.test(lowerText)) {
        await replyAndSave('Entendido, un operador te va a contactar 🙌', { markInProgress: true });
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
        await replyAndSave('Entendido, un operador te va a contactar 🙌', { markInProgress: true });
      } else {
        await replyAndSave('Sos de cargar y jugar seguido? Respondé si o no 😊');
      }
      break;
    }

    // ── Capture user name ─────────────────────────────────────────────────────
    case 'asked_name': {
      const name = text.split('\n')[0].split(' ').slice(0, 3).join(' ').trim();
      if (name) {
        try {
          await supabaseAdmin.from('contacts').update({ name }).eq('id', contact.id);
        } catch {}
      }
      await replyAndSave(
        `Perfecto ${name || 'amigo'}! 🎉 Un operador te crea el usuario enseguida y te manda los datos para entrar.`,
        { markInProgress: true },
      );
      break;
    }

    // ── Completed or unknown state ────────────────────────────────────────────
    case 'done':
    default: {
      console.warn(`[bot] Estado no mapeado: "${state}" — respondiendo genérico`);
      await replyAndSave(
        'Hola! En qué te puedo ayudar? Escribí "hola" para empezar de nuevo 😊',
        { newState: null },
      );
      break;
    }
  }
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

async function findOrCreateContact(phone: string, name: string | null) {
  try {
    const { data: existing } = await supabaseAdmin
      .from('contacts')
      .select('*')
      .eq('phone', phone)
      .limit(1)
      .maybeSingle();

    if (existing) {
      if (name && !existing.name) {
        await supabaseAdmin.from('contacts').update({ name }).eq('id', existing.id).catch(() => {});
      }
      return existing;
    }

    const { data: inserted, error } = await supabaseAdmin
      .from('contacts')
      .insert({ phone, name, status: 'nuevo' })
      .select('*')
      .single();

    if (error) {
      console.error('[findOrCreateContact] Insert error:', error.message);
      // Race condition: try fetching again
      const { data: retry } = await supabaseAdmin
        .from('contacts').select('*').eq('phone', phone).limit(1).maybeSingle();
      return retry ?? null;
    }

    return inserted;
  } catch (err) {
    console.error('[findOrCreateContact] Excepción:', err);
    return null;
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
