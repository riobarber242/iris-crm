import axios from 'axios';
import { verifyMetaSignature } from './verify';
import { sendWhatsAppText, fetchWhatsAppMediaUrl } from './client';
import { supabaseAdmin } from '../db';
import { generateAmountFromImage } from '../groq';

const COMPROBANTES_BUCKET = 'comprobantes';
const BOT_ENABLED_KEY = 'bot_enabled';

// Explicit conversation state machine values stored in contacts.conversation_state
// null          → no conversation started yet, send greeting on next message
// 'greeting'    → bot sent initial greeting, waiting for any response
// 'asked_intention' → bot asked "fichas o cargar?", waiting for choice
// 'sent_channel_link' → bot sent channel link, waiting for any reply
// 'waiting_screenshot' → bot asked for screenshot, waiting for image
// 'asked_if_loader' → bot asked "sos de cargar?", waiting for yes/no
// 'asked_name'  → bot asked for name, waiting for name text
// 'done'        → flow completed, human takes over (status = en_proceso)

function getExtensionFromUrl(url: string, contentType?: string) {
  try {
    const pathname = new URL(url).pathname;
    const ext = pathname.split('.').pop();
    if (ext && ext.length > 0 && ext.length <= 5) {
      return ext.split('?')[0];
    }
  } catch {
    // ignore
  }
  if (contentType) {
    if (contentType.includes('jpeg')) return 'jpg';
    if (contentType.includes('png')) return 'png';
    if (contentType.includes('gif')) return 'gif';
    if (contentType.includes('webp')) return 'webp';
  }
  return 'jpg';
}

async function downloadMediaBuffer(url: string) {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const response = await axios.get<ArrayBuffer>(url, { responseType: 'arraybuffer', headers });
  return {
    buffer: Buffer.from(response.data),
    contentType: response.headers['content-type'] as string | undefined,
  };
}

async function ensureStorageBucket() {
  try {
    const { error } = await supabaseAdmin.storage.getBucket(COMPROBANTES_BUCKET);
    if (error && /not found|404/i.test(error.message)) {
      await supabaseAdmin.storage.createBucket(COMPROBANTES_BUCKET, { public: true });
    }
  } catch (err) {
    console.error('[ensureStorageBucket] Error:', err);
  }
}

async function uploadComprobanteImage(imageUrl: string, contactId: string): Promise<string | null> {
  try {
    await ensureStorageBucket();
    const { buffer, contentType } = await downloadMediaBuffer(imageUrl);
    const extension = getExtensionFromUrl(imageUrl, contentType);
    const filePath = `${contactId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${extension}`;

    console.log(`[uploadComprobanteImage] Subiendo → bucket=${COMPROBANTES_BUCKET} path=${filePath} contentType=${contentType}`);

    const { data: uploadData, error: uploadError } = await supabaseAdmin.storage
      .from(COMPROBANTES_BUCKET)
      .upload(filePath, buffer, { contentType, upsert: false });

    if (uploadError) {
      console.error('[uploadComprobanteImage] Error subiendo:', uploadError.message);
      return null;
    }

    console.log('[uploadComprobanteImage] Upload OK path:', uploadData?.path);

    const { data: publicUrlData } = await supabaseAdmin.storage
      .from(COMPROBANTES_BUCKET)
      .getPublicUrl(filePath);

    const publicUrl = publicUrlData?.publicUrl ?? null;
    console.log('[uploadComprobanteImage] Public URL:', publicUrl);
    return publicUrl;
  } catch (err) {
    console.error('[uploadComprobanteImage] Error general:', err);
    return null;
  }
}

export async function handleWhatsappWebhook(
  rawBody: string,
  signature: string | undefined,
  payload: any,
) {
  if (!verifyMetaSignature(signature, rawBody)) {
    return { status: 401, body: 'Firma no valida' };
  }

  const entries = payload.entry ?? [];
  for (const entry of entries) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      for (const message of value.messages ?? []) {
        try {
          await processIncomingWhatsAppMessage(
            value.metadata?.phone_number_id,
            message,
            value.contacts?.[0],
          );
        } catch (err) {
          console.error('[webhook] Error no manejado procesando mensaje:', err);
        }
      }
    }
  }

  return { status: 200, body: 'EVENT_RECEIVED' };
}

async function processIncomingWhatsAppMessage(
  _phoneNumberId: string | undefined,
  message: any,
  contactMeta: any,
) {
  const messageId = message.id;
  const from = message.from;
  const type = message.type;
  const text = message.text?.body?.trim() ?? '';

  console.log(`[webhook] Entrante: from=${from} type=${type} text="${text.slice(0, 60)}"`);

  if (!messageId || !from) return;

  // Deduplicate
  const { data: existingMsg } = await supabaseAdmin
    .from('messages')
    .select('id')
    .eq('whatsapp_message_id', messageId)
    .maybeSingle();
  if (existingMsg) return;

  const contact = await findOrCreateContact(from, contactMeta?.profile?.name ?? null);
  if (!contact) {
    console.error('[webhook] No se pudo obtener/crear contacto para', from);
    return;
  }

  // Save incoming user message
  await supabaseAdmin.from('messages').insert({
    contact_id: contact.id,
    role: 'user',
    content: type === 'text' ? text : type,
    whatsapp_message_id: messageId,
  });

  const botEnabled = await getBotEnabled();
  console.log(
    `[webhook] bot_enabled=${botEnabled} contact.id=${contact.id} ` +
    `status=${contact.status} conversation_state=${contact.conversation_state}`,
  );

  // ─── helper: send reply, save to DB, update conversation_state ───────────
  async function replyAndSave(
    textResp: string,
    opts: { newState?: string | null; markInProgress?: boolean } = {},
  ) {
    const { data: inserted, error: insertError } = await supabaseAdmin
      .from('messages')
      .insert({ contact_id: contact.id, role: 'assistant', content: textResp })
      .select('id')
      .single();

    if (insertError || !inserted) {
      console.error('[replyAndSave] Error insertando mensaje:', insertError?.message);
      try { await sendWhatsAppText(from, textResp); } catch (e) {
        console.error('[replyAndSave] Error enviando WhatsApp (sin DB row):', e);
      }
    } else {
      try {
        await sendWhatsAppText(from, textResp);
        await supabaseAdmin.from('messages').update({ status: 'sent' }).eq('id', inserted.id);
      } catch (err) {
        console.error('[replyAndSave] Error enviando WhatsApp:', err);
        await supabaseAdmin.from('messages').update({ status: 'failed' }).eq('id', inserted.id);
      }
    }

    // Update conversation_state and/or status
    const updates: Record<string, any> = {};
    if ('newState' in opts) updates.conversation_state = opts.newState ?? null;
    if (opts.markInProgress) {
      updates.status = 'en_proceso';
      updates.conversation_state = 'done';
    }
    if (Object.keys(updates).length > 0) {
      await supabaseAdmin.from('contacts').update(updates).eq('id', contact.id);
    }
  }

  // ─── IMAGE / DOCUMENT ────────────────────────────────────────────────────
  if (type === 'image' || type === 'document') {
    const mediaId = message.image?.id ?? message.document?.id ?? null;
    console.log(`[handleCaptureImageFlow] mediaId=${mediaId} type=${type}`);

    let supabaseImageUrl: string | null = null;

    if (mediaId) {
      let downloadUrl: string | null = null;
      try {
        downloadUrl = await fetchWhatsAppMediaUrl(mediaId);
        console.log(`[handleCaptureImageFlow] downloadUrl=${downloadUrl}`);
      } catch (err) {
        console.error('[handleCaptureImageFlow] Error obteniendo downloadUrl:', err);
      }

      if (downloadUrl) {
        supabaseImageUrl = await uploadComprobanteImage(downloadUrl, contact.id);
      }
    } else {
      console.error('[handleCaptureImageFlow] Sin mediaId — guardando sin imagen');
    }

    console.log(`[handleCaptureImageFlow] supabaseImageUrl=${supabaseImageUrl}`);

    const amount = supabaseImageUrl
      ? await generateAmountFromImage(supabaseImageUrl).catch(() => 0)
      : 0;

    await supabaseAdmin.from('comprobantes').insert({
      contact_id: contact.id,
      image_url: supabaseImageUrl,
      monto: amount,
      estado: 'pendiente',
    });

    if (botEnabled) {
      await replyAndSave('Buenisimo! Sos de cargar y jugar seguido?', {
        newState: 'asked_if_loader',
      });
    }
    return;
  }

  // ─── TEXT: bot must be enabled to continue ───────────────────────────────
  if (!botEnabled) return;

  // GREETING RESET — evaluated FIRST, before any status guard.
  // A saludo always resets the flow regardless of conversation_state or status.
  const isGreeting =
    /^(hola|buenas|hey|buen\s*d[ií]a|buenos\s*d[ií]as|buenas\s*tardes|buenas\s*noches|ola|hi|hello|saludos|que\s*tal|como\s*estas|buenos)[!¡.,\s]*/i.test(
      text.trim(),
    );

  if (isGreeting) {
    console.log(`[bot] Saludo — reseteando estado (era status=${contact.status} state=${contact.conversation_state})`);
    await replyAndSave(
      'Buenas mi nombre es Iris, por favor agendame para poder seguir con la conversacion',
      { newState: 'greeting' },
    );
    // Also reset status so bot is no longer silenced
    await supabaseAdmin.from('contacts').update({ status: 'nuevo' }).eq('id', contact.id);
    return;
  }

  // If human operator took over (and it's not a greeting), bot stays silent
  if (contact.status === 'en_proceso') {
    console.log(`[bot] en_proceso y no es saludo — bot silenciado`);
    return;
  }

  // ─── EXPLICIT STATE MACHINE ───────────────────────────────────────────────
  const state: string | null = contact.conversation_state ?? null;
  const lowerText = text.toLowerCase();
  console.log(`[bot] state="${state}" text="${text.slice(0, 60)}"`);

  switch (state) {
    case null:
    case 'greeting': {
      // Any message after greeting → ask what they want
      await replyAndSave('Venis por las fichas de prueba o queres cargar?', {
        newState: 'asked_intention',
      });
      break;
    }

    case 'asked_intention': {
      if (/carg(ar|a)|quiero cargar|quiero recarg/.test(lowerText)) {
        await replyAndSave('Perfecto! Dame un momento que te atiendo enseguida', {
          markInProgress: true,
        });
      } else if (/fichas|prueba|proba|prueb/.test(lowerText)) {
        await replyAndSave(
          'Unite a mi canal de WhatsApp y mandame captura. Ahi subo promos, horarios de atencion y lineas disponibles: https://whatsapp.com/channel/0029VbCHhpyGOj9me9y9pF3F',
          { newState: 'sent_channel_link' },
        );
      } else {
        await replyAndSave('Venis por las fichas de prueba o queres cargar?');
      }
      break;
    }

    case 'sent_channel_link': {
      await replyAndSave(
        'Para poder seguir necesito que me mandes la captura del canal',
        { newState: 'waiting_screenshot' },
      );
      break;
    }

    case 'waiting_screenshot': {
      if (/no puedo|no puedo mandar|no puedo enviar|no puedo mandarlo|no puedo subir/.test(lowerText)) {
        await replyAndSave('Entendido, dame un momento', { markInProgress: true });
      } else {
        await replyAndSave(
          'Necesito que me mandes la captura del canal de WhatsApp para poder continuar. Si no podes, avisame.',
        );
      }
      break;
    }

    case 'asked_if_loader': {
      if (/(^si$|^sí$|obvio|claro|siempre|dale|si!|sí!)/.test(lowerText)) {
        await replyAndSave(
          'Buenisimo porque lo que estoy buscando son clientes que carguen conmigo. Las fichas de regalo son solo para probar la plataforma. Los premios se retiran cuando ganas jugando con una carga. Si estas de acuerdo, decime tu nombre y te creo el usuario. Aprovecha despues a cargar que les doy un 20% mas de lo que carguen',
          { newState: 'asked_name' },
        );
      } else if (/(^no$|nono|no puedo|no gracias)/.test(lowerText)) {
        await replyAndSave('Entendido, dame un momento', { markInProgress: true });
      } else {
        await replyAndSave('Sos de cargar y jugar seguido?');
      }
      break;
    }

    case 'asked_name': {
      const name = text.split('\n')[0].split(' ').slice(0, 3).join(' ').trim();
      if (name) {
        await supabaseAdmin.from('contacts').update({ name }).eq('id', contact.id);
      }
      await replyAndSave(`Perfecto ${name || 'amigo'}! Dame un momento que te preparo todo`, {
        markInProgress: true,
      });
      break;
    }

    case 'done':
    default: {
      console.warn(`[bot] Estado no mapeado: "${state}" — respondiendo genérico`);
      await replyAndSave('Hola! En que te puedo ayudar?', { newState: null });
      break;
    }
  }
}

async function findOrCreateContact(phone: string, name: string | null) {
  const { data: existing } = await supabaseAdmin
    .from('contacts')
    .select('*')
    .eq('phone', phone)
    .limit(1)
    .maybeSingle();

  if (existing) {
    if (name && !existing.name) {
      await supabaseAdmin.from('contacts').update({ name }).eq('id', existing.id);
    }
    return existing;
  }

  const { data: inserted, error: insertError } = await supabaseAdmin
    .from('contacts')
    .insert({ phone, name, status: 'nuevo' })
    .select('*')
    .single();

  if (insertError) {
    console.error('[findOrCreateContact] Error insertando:', insertError.message);
    // Race condition — try fetching again
    const { data: retry } = await supabaseAdmin
      .from('contacts')
      .select('*')
      .eq('phone', phone)
      .limit(1)
      .maybeSingle();
    return retry as any;
  }

  return inserted as any;
}

async function getBotEnabled(): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from('settings')
    .select('value')
    .eq('key', BOT_ENABLED_KEY)
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error('[getBotEnabled] Error:', error.message);
    return true;
  }

  const raw = data?.value;
  const enabled = raw !== 'false' && raw !== false;
  console.log(`[getBotEnabled] raw=${JSON.stringify(raw)} → enabled=${enabled}`);
  return enabled;
}
