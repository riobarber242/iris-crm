import { verifyMetaSignature } from './verify';
import { sendWhatsAppText } from './client';
import { supabaseAdmin } from '../db';
import { generateBotResponse, generateAmountFromImage } from '../groq';
import { irisSystemPrompt } from '../system-prompt';

const CLUB_URL_SETTING_KEY = 'club_de_la_suerte_link';

export async function handleWhatsappWebhook(rawBody: string, signature: string | undefined, payload: any) {
  if (!verifyMetaSignature(signature, rawBody)) {
    return { status: 401, body: 'Firma no válida' };
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

  const dedup = await supabaseAdmin
    .from('messages')
    .select('id')
    .eq('whatsapp_message_id', messageId)
    .single();

  if (dedup.data) {
    return;
  }

  const contact = await findOrCreateContact(from, contactMeta?.profile?.name ?? null);

  await supabaseAdmin.from('messages').insert({
    contact_id: contact.id,
    role: 'user',
    content: type === 'text' ? text : type,
    whatsapp_message_id: messageId,
  });

  if (type === 'image' || type === 'document') {
    await handleComprobanteImage(contact.id, message, from);
    return;
  }

  const response = await buildAssistantResponse(contact, text);
  const { data: inserted } = await supabaseAdmin.from('messages').insert({
    contact_id: contact.id,
    role: 'assistant',
    content: response,
    status: 'sending',
  }).select('*').single();

  try {
    await sendWhatsAppText(from, response);
    if (inserted?.id) {
      await supabaseAdmin.from('messages').update({ status: 'sent' }).eq('id', inserted.id);
    }
  } catch (err) {
    console.error('Error sending WhatsApp message:', err);
    if (inserted?.id) {
      await supabaseAdmin.from('messages').update({ status: 'failed' }).eq('id', inserted.id);
    }
  }
}

async function findOrCreateContact(phone: string, name: string | null) {
  const { data: existing } = await supabaseAdmin
    .from('contacts')
    .select('*')
    .eq('phone', phone)
    .single();

  if (existing) {
    const updates: Record<string, any> = {};
    if (!existing.name && name) {
      updates.name = name;
    }
    if (Object.keys(updates).length > 0) {
      await supabaseAdmin.from('contacts').update(updates).eq('id', existing.id);
    }
    return existing;
  }

  const { data: contact } = await supabaseAdmin.from('contacts').insert({
    phone,
    name,
    status: 'nuevo',
    joined_channel: false,
    user_created: false,
    blocked: false,
  }).select('*').single();

  if (!contact) {
    throw new Error('No se pudo crear el contacto');
  }

  return contact;
}

async function handleComprobanteImage(contactId: string, message: any, to: string) {
  const imageUrl = message.image?.link ?? message.document?.link;
  if (!imageUrl) {
    await sendWhatsAppText(to, 'No pude leer la imagen, mandamela de nuevo por favor.');
    return;
  }

  const monto = await generateAmountFromImage(imageUrl);
  await supabaseAdmin.from('comprobantes').insert({
    contact_id: contactId,
    image_url: imageUrl,
    monto,
    estado: 'pendiente',
  });
  try {
    await sendWhatsAppText(to, 'Gracias, ya guardé tu comprobante y lo tengo en revisión.');
  } catch (err) {
    console.error('Error sending comprobante confirmation:', err);
  }
}

async function buildAssistantResponse(contact: any, incomingText: string) {
  const clubUrl = await getSetting(CLUB_URL_SETTING_KEY, 'https://t.me/ElClubDeLaSuerteDeIris');
  const prompt = `${irisSystemPrompt}

Contacto: ${contact.name ?? 'cliente'}
Mensaje: ${incomingText}
Canal: ${clubUrl}`;

  if (isHumanRoute(incomingText)) {
    return 'Entiendo que preferís hablar con alguien de atención. Te paso con un operador humano en un momento.';
  }

  if (incomingText.toUpperCase().includes('QUIERO EL 15%')) {
    return 'Para activar el bonus tenés que hacer una recarga mínima de 500 y mandar tu comprobante, después te aviso cuando esté aprobado.';
  }

  if (contact.status === 'nuevo') {
    return `Hola! Soy Iris, tu asistente. Guardame como contacto y sumate al club acá: ${clubUrl}. Mientras preparo tu cuenta, te aviso cómo sigue.`;
  }

  return await generateBotResponse(prompt, incomingText);
}

function isHumanRoute(text: string) {
  const angryKeywords = ['enoj', 'molest', 'reclamo', 'queja', 'mal', 'pésim'];
  return angryKeywords.some((word) => text.toLowerCase().includes(word));
}

async function getSetting(key: string, fallback: string) {
  const { data } = await supabaseAdmin.from('settings').select('value').eq('key', key).single();
  return data?.value ?? fallback;
}
