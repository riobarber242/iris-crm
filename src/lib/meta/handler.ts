import axios from 'axios';
import { verifyMetaSignature } from './verify';
import { sendWhatsAppText, fetchWhatsAppMediaUrl } from './client';
import { supabaseAdmin } from '../db';
import { generateBotResponse, generateAmountFromImage } from '../groq';
import { irisSystemPrompt } from '../system-prompt';

const COMPROBANTES_BUCKET = 'comprobantes';
const BOT_ENABLED_KEY = 'bot_enabled';

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
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  const response = await axios.get<ArrayBuffer>(url, {
    responseType: 'arraybuffer',
    headers,
  });
  return {
    buffer: Buffer.from(response.data),
    contentType: response.headers['content-type'] as string | undefined,
  };
}

async function ensureStorageBucket() {
  try {
    const { data, error } = await supabaseAdmin.storage.getBucket(COMPROBANTES_BUCKET);
    if (error && /not found|404/i.test(error.message)) {
      await supabaseAdmin.storage.createBucket(COMPROBANTES_BUCKET, { public: true });
    }
    return data;
  } catch (error) {
    console.error('Error asegurando bucket de storage:', error);
    return null;
  }
}

async function uploadComprobanteImage(imageUrl: string, contactId: string) {
  try {
    await ensureStorageBucket();
    const { buffer, contentType } = await downloadMediaBuffer(imageUrl);
    const extension = getExtensionFromUrl(imageUrl, contentType);
    const filePath = `comprobantes/${contactId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${extension}`;

    const { data: uploadData, error: uploadError } = await supabaseAdmin.storage
      .from(COMPROBANTES_BUCKET)
      .upload(filePath, buffer, { contentType, upsert: false });

    if (uploadError) {
      console.error('Error subiendo imagen a Supabase Storage:', uploadError);
      return null;
    }

    const { data: publicUrlData, error: publicUrlError } = await supabaseAdmin.storage
      .from(COMPROBANTES_BUCKET)
      .getPublicUrl(filePath);

    if (publicUrlError) {
      console.error('Error obteniendo public URL:', publicUrlError);
      return null;
    }

    return publicUrlData.publicUrl;
  } catch (error) {
    console.error('Error descargando o subiendo imagen:', error);
    return null;
  }
}

export async function handleWhatsappWebhook(rawBody: string, signature: string | undefined, payload: any) {
  if (!verifyMetaSignature(signature, rawBody)) {
    return { status: 401, body: 'Firma no valida' };
  }

  const entries = payload.entry ?? [];
  for (const entry of entries) {
    const changes = entry.changes ?? [];
    for (const change of changes) {
      const value = change.value;
      const messages = value.messages ?? [];
      for (const message of messages) {
        await processIncomingWhatsAppMessage(value.metadata?.phone_number_id, message, value.contacts?.[0]);
      }
    }
  }

  return { status: 200, body: 'EVENT_RECEIVED' };
}

async function processIncomingWhatsAppMessage(phoneNumberId: string | undefined, message: any, contactMeta: any) {
  const messageId = message.id;
  const from = message.from;
  const type = message.type;
  const text = message.text?.body?.trim() ?? '';

  if (!messageId || !from) {
    return;
  }

  const existingMessage = await supabaseAdmin
    .from('messages')
    .select('id')
    .eq('whatsapp_message_id', messageId)
    .maybeSingle();

  if (existingMessage.data) {
    return;
  }

  const contact = await findOrCreateContact(from, contactMeta?.profile?.name ?? null);

  await supabaseAdmin.from('messages').insert({
    contact_id: contact.id,
    role: 'user',
    content: type === 'text' ? text : type,
    whatsapp_message_id: messageId,
  });

  async function replyAndSave(textResp: string, markInProgress = false) {
    const { data: inserted, error: insertError } = await supabaseAdmin
      .from('messages')
      .insert({
        contact_id: contact.id,
        role: 'assistant',
        content: textResp,
      })
      .select('*')
      .single();

    if (insertError || !inserted) {
      console.error('Error inserting assistant message', insertError);
      // attempt to send even if DB insert failed
      try {
        await sendWhatsAppText(from, textResp);
      } catch (e) {
        console.error('Error sending WhatsApp message (no DB row):', e);
      }
      if (markInProgress) await supabaseAdmin.from('contacts').update({ status: 'en_proceso' }).eq('id', contact.id);
      return;
    }

    try {
      await sendWhatsAppText(from, textResp);
      if (inserted?.id) await supabaseAdmin.from('messages').update({ status: 'sent' }).eq('id', inserted.id);
      if (markInProgress) await supabaseAdmin.from('contacts').update({ status: 'en_proceso' }).eq('id', contact.id);
    } catch (err) {
      console.error('Error sending WhatsApp message:', err);
      if (inserted?.id) await supabaseAdmin.from('messages').update({ status: 'failed' }).eq('id', inserted.id);
      if (markInProgress) await supabaseAdmin.from('contacts').update({ status: 'en_proceso' }).eq('id', contact.id);
    }
  }

  async function resolveImageUrl() {
    if (message.image?.link) return message.image.link;
    if (message.image?.url) return message.image.url;
    if (message.image?.id) {
      try {
        return await fetchWhatsAppMediaUrl(message.image.id);
      } catch (error) {
        console.error('Error fetching WhatsApp image URL:', error);
      }
    }

    if (message.document?.link) return message.document.link;
    if (message.document?.url) return message.document.url;
    if (message.document?.id) {
      try {
        return await fetchWhatsAppMediaUrl(message.document.id);
      } catch (error) {
        console.error('Error fetching WhatsApp document URL:', error);
      }
    }

    return null;
  }

  const botEnabled = await getBotEnabled();

  async function handleCaptureImageFlow() {
    const imageUrl = await resolveImageUrl();
    const amount = imageUrl ? await generateAmountFromImage(imageUrl).catch(() => 0) : 0;
    let storedImageUrl: string | null = null;

    if (imageUrl) {
      storedImageUrl = await uploadComprobanteImage(imageUrl, contact.id);
    }

    const imageUrlToSave = storedImageUrl ?? imageUrl;
    if (imageUrlToSave) {
      await supabaseAdmin.from('comprobantes').insert({
        contact_id: contact.id,
        image_url: imageUrlToSave,
        monto: amount,
        estado: 'pendiente',
      });
    }

    if (botEnabled) {
      await replyAndSave('Buenisimo! Sos de cargar y jugar seguido?');
    }
  }

  if (type === 'image' || type === 'document') {
    await handleCaptureImageFlow();
    return;
  }

  if (!botEnabled) {
    return;
  }

  const { data: lastAssistant } = await supabaseAdmin
    .from('messages')
    .select('*')
    .eq('contact_id', contact.id)
    .eq('role', 'assistant')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  const lastAssistantText = lastAssistant?.content ?? '';

  if (!lastAssistantText) {
    await replyAndSave('Buenas mi nombre es Iris, por favor agendame para poder seguir con la conversacion');
    return;
  }

  if (lastAssistantText.toLowerCase().includes('mi nombre es iris')) {
    await replyAndSave('Venis por las fichas de prueba o queres cargar?');
    return;
  }

  if (lastAssistantText.toLowerCase().includes('fichas de prueba') || lastAssistantText.toLowerCase().includes('queres cargar')) {
    const lowerText = text.toLowerCase();

    if (/carg(ar|a)|quiero cargar|quiero recarg/.test(lowerText)) {
      await replyAndSave('Perfecto! Dame un momento que te atiendo enseguida', true);
      return;
    }

    if (/fichas|prueba|proba|prueb/.test(lowerText)) {
      await replyAndSave(
        'Unite a mi canal de WhatsApp y mandame captura. Ahi subo promos, horarios de atencion y lineas disponibles: https://whatsapp.com/channel/0029VbCHhpyGOj9me9y9pF3F'
      );
      return;
    }

    await replyAndSave('Venis por las fichas de prueba o queres cargar?');
    return;
  }

  if (lastAssistantText.toLowerCase().includes('unite a mi canal')) {
    await replyAndSave('Para poder seguir necesito que me mandes la captura del canal');
    return;
  }

  if (/no puedo|no puedo mandar|no puedo enviar|no puedo mandarlo|no puedo subir/.test(text.toLowerCase())) {
    await replyAndSave('Entendido, dame un momento', true);
    return;
  }

  if (lastAssistantText.toLowerCase().includes('sos de cargar y jugar') || lastAssistantText.toLowerCase().includes('sos de cargar y jugar seguido')) {
    const lowerText = text.toLowerCase();

    if (/(si|si|obvio|claro|siempre|si,)/.test(lowerText)) {
      await replyAndSave(
        'Buenisimo porque lo que estoy buscando son clientes que carguen conmigo. Las fichas de regalo son solo para probar la plataforma. Los premios se retiran cuando ganas jugando con una carga. Si estas de acuerdo, decime tu nombre y te creo el usuario. Aprovecha despues a cargar que les doy un 20% mas de lo que carguen'
      );
      return;
    }

    if (/(no|nono|no puedo|no gracias)/.test(lowerText)) {
      await replyAndSave('Entendido, dame un momento', true);
      return;
    }

    await replyAndSave('Sos de cargar y jugar seguido?');
    return;
  }

  if (lastAssistantText.toLowerCase().includes('decime tu nombre') || lastAssistantText.toLowerCase().includes('decime tu nombre y te creo el usuario')) {
    const name = text.split('\\n')[0].split(' ').slice(0, 3).join(' ').trim();

    if (name) {
      await supabaseAdmin.from('contacts').update({ name }).eq('id', contact.id);
    }

    await replyAndSave(`Perfecto ${name}! Dame un momento que te preparo todo`, true);
    return;
  }

  try {
    const fallback = await generateBotResponse(
      irisSystemPrompt + `\\nContacto: ${contact.name ?? 'cliente'}\\nMensaje: ${text}`,
      text
    );
    await replyAndSave(fallback);
    return;
  } catch (e) {
    console.error('Groq fallback error', e);
  }

  await replyAndSave('Perdon, no entendi. Podes repetir?');
}

async function findOrCreateContact(phone: string, name: string | null) {
  const { data: existing } = await supabaseAdmin.from('contacts').select('*').eq('phone', phone).single();

  if (existing) {
    if (name && !existing.name) {
      await supabaseAdmin.from('contacts').update({ name }).eq('id', existing.id);
    }
    return existing;
  }

  const { data: inserted } = await supabaseAdmin
    .from('contacts')
    .insert({ phone, name, status: 'nuevo' })
    .select('*')
    .single();

  return inserted as any;
}

async function getBotEnabled(): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from('settings')
    .select('value')
    .eq('key', BOT_ENABLED_KEY)
    .maybeSingle();

  if (error) {
    console.error('[getBotEnabled] Error leyendo settings:', error.message);
    return true;
  }

  const raw = data?.value;
  // Handle both string ('true'/'false') and boolean (true/false)
  const enabled = raw !== 'false' && raw !== false;
  console.log(`[getBotEnabled] raw=${JSON.stringify(raw)} → enabled=${enabled}`);
  return enabled;
}
