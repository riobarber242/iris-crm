import axios from 'axios';
import { verifyMetaSignature } from './verify';
import { sendWhatsAppText, fetchWhatsAppMediaUrl } from './client';
import { supabaseAdmin } from '../db';
import { generateAmountFromImage } from '../groq';

const COMPROBANTES_BUCKET = 'comprobantes';
const BOT_ENABLED_KEY     = 'bot_enabled';

// ─── Storage helpers ──────────────────────────────────────────────────────────

function getExtensionFromUrl(url: string, contentType?: string) {
  try {
    const ext = new URL(url).pathname.split('.').pop();
    if (ext && ext.length <= 5) return ext.split('?')[0];
  } catch {}
  if (contentType?.includes('jpeg')) return 'jpg';
  if (contentType?.includes('png'))  return 'png';
  if (contentType?.includes('gif'))  return 'gif';
  if (contentType?.includes('webp')) return 'webp';
  return 'jpg';
}

async function downloadMediaBuffer(url: string) {
  const token   = process.env.WHATSAPP_ACCESS_TOKEN;
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const response = await axios.get<ArrayBuffer>(url, { responseType: 'arraybuffer', headers });
  return {
    buffer:      Buffer.from(response.data),
    contentType: response.headers['content-type'] as string | undefined,
  };
}

async function ensureStorageBucket() {
  try {
    const { error } = await supabaseAdmin.storage.getBucket(COMPROBANTES_BUCKET);
    if (error && /not found|404/i.test(error.message)) {
      await supabaseAdmin.storage.createBucket(COMPROBANTES_BUCKET, { public: true });
      console.log(`[storage] Bucket '${COMPROBANTES_BUCKET}' creado`);
    }
  } catch (err) {
    console.error('[ensureStorageBucket]', err);
  }
}

async function uploadComprobanteImage(imageUrl: string, contactId: string): Promise<string | null> {
  try {
    await ensureStorageBucket();
    const { buffer, contentType } = await downloadMediaBuffer(imageUrl);
    const ext      = getExtensionFromUrl(imageUrl, contentType);
    const filePath = `${contactId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

    console.log(`[uploadComprobanteImage] Subiendo → path=${filePath} contentType=${contentType}`);

    const { data: uploadData, error: uploadError } = await supabaseAdmin.storage
      .from(COMPROBANTES_BUCKET)
      .upload(filePath, buffer, { contentType, upsert: false });

    if (uploadError) {
      console.error('[uploadComprobanteImage] Upload error:', uploadError.message);
      return null;
    }

    console.log('[uploadComprobanteImage] OK path:', uploadData?.path);

    const { data: pub } = await supabaseAdmin.storage
      .from(COMPROBANTES_BUCKET)
      .getPublicUrl(filePath);

    console.log('[uploadComprobanteImage] Public URL:', pub?.publicUrl);
    return pub?.publicUrl ?? null;
  } catch (err) {
    console.error('[uploadComprobanteImage] Error general:', err);
    return null;
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
    try {
      const updates: Record<string, any> = {};
      if ('newState' in opts)   updates.conversation_state = opts.newState ?? null;
      if (opts.markInProgress) { updates.status = 'en_proceso'; updates.conversation_state = 'done'; }
      if (Object.keys(updates).length > 0) {
        const { error } = await supabaseAdmin.from('contacts').update(updates).eq('id', contact.id);
        if (error) console.warn('[replyAndSave] Contact update error:', error.message);
      }
    } catch (err) {
      console.error('[replyAndSave] Contact update excepción:', err);
    }
  }

  // ─── IMAGE / DOCUMENT ─────────────────────────────────────────────────────
  if (type === 'image' || type === 'document') {
    const mediaId = message.image?.id ?? message.document?.id ?? null;
    console.log(`[image] mediaId=${mediaId}`);

    let supabaseImageUrl: string | null = null;

    if (mediaId) {
      let downloadUrl: string | null = null;
      try {
        downloadUrl = await fetchWhatsAppMediaUrl(mediaId);
        console.log(`[image] downloadUrl=${downloadUrl?.slice(0, 80)}`);
      } catch (err) {
        console.error('[image] Error obteniendo downloadUrl:', err);
      }

      if (downloadUrl) {
        supabaseImageUrl = await uploadComprobanteImage(downloadUrl, contact.id);
      }
    } else {
      console.warn('[image] Sin mediaId en el mensaje');
    }

    console.log(`[image] supabaseImageUrl=${supabaseImageUrl}`);

    const amount = supabaseImageUrl
      ? await generateAmountFromImage(supabaseImageUrl).catch(() => 0)
      : 0;

    try {
      const { error } = await supabaseAdmin.from('comprobantes').insert({
        contact_id: contact.id,
        image_url:  supabaseImageUrl,   // null if upload failed — NEVER a Facebook URL
        monto:      amount,
        estado:     'pendiente',
      });
      if (error) console.error('[image] Error guardando comprobante:', error.message);
    } catch (err) {
      console.error('[image] Excepción guardando comprobante:', err);
    }

    if (botEnabled) {
      await replyAndSave('Buenisimo! Sos de cargar y jugar seguido?', { newState: 'asked_if_loader' });
    }
    return;
  }

  // ─── TEXT MESSAGES ────────────────────────────────────────────────────────
  if (!botEnabled) {
    console.log('[bot] bot_enabled=false — sin respuesta automática');
    return;
  }

  // GREETING RESET — runs BEFORE en_proceso check so saludos always unblock
  const isGreeting = /^(hola|buenas|hey|buen\s*d[ií]a|buenos\s*d[ií]as|buenas\s*tardes|buenas\s*noches|ola|hi|hello|saludos|que\s*tal|como\s*estas|buenos)[!¡.,\s]*/i.test(text.trim());

  if (isGreeting) {
    console.log(`[bot] Saludo — reseteando (status=${contact.status} state=${contact.conversation_state})`);
    await replyAndSave(
      'Buenas 🙌 mi nombre es Iris, agendame para poder seguir con la conversacion',
      { newState: 'greeting' },
    );
    try {
      await supabaseAdmin.from('contacts').update({ status: 'nuevo' }).eq('id', contact.id);
    } catch {}
    return;
  }

  // Human operator took over — bot is silent (except for greetings above)
  if (contact.status === 'en_proceso') {
    console.log('[bot] en_proceso y no es saludo — bot silenciado');
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
    const { data, error } = await supabaseAdmin
      .from('settings')
      .select('value')
      .eq('key', BOT_ENABLED_KEY)
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error('[getBotEnabled] Error:', error.message);
      return true; // fail open
    }

    const raw     = data?.value;
    const enabled = raw !== 'false' && raw !== false;
    console.log(`[getBotEnabled] raw=${JSON.stringify(raw)} → enabled=${enabled}`);
    return enabled;
  } catch (err) {
    console.error('[getBotEnabled] Excepción:', err);
    return true; // fail open
  }
}
