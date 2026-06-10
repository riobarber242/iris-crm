import axios from 'axios';
import { supabaseAdmin } from '../db';

const BASE_URL = 'https://graph.facebook.com/v18.0';

function getToken(): string {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!token) throw new Error('[WhatsApp] WHATSAPP_ACCESS_TOKEN no configurado en Vercel env vars');
  return token;
}

function getPhoneNumberId(): string {
  const id = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!id) throw new Error('[WhatsApp] WHATSAPP_PHONE_NUMBER_ID no configurado en Vercel env vars');
  return id;
}

// WhatsApp Business Account ID (WABA) — necesario para crear plantillas.
function getBusinessAccountId(): string {
  const id = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID ?? process.env.WHATSAPP_WABA_ID;
  if (!id) throw new Error('[WhatsApp] WHATSAPP_BUSINESS_ACCOUNT_ID no configurado en Vercel env vars');
  return id;
}

// Resuelve las credenciales de WhatsApp a usar para enviar.
//  · Si `tenantId` tiene en la tabla tenants AMBOS (whatsapp_access_token y
//    whatsapp_phone_id) → usa ese par (envía desde el número del tenant).
//  · Si no (tenant sin credenciales propias, o sin tenantId) → fallback a las
//    env vars globales. Es un par atómico: nunca se mezcla token de un origen con
//    phone_id de otro.
async function resolveCreds(tenantId?: string): Promise<{ token: string; phoneId: string }> {
  if (tenantId) {
    try {
      const { data } = await supabaseAdmin
        .from('tenants')
        .select('whatsapp_access_token, whatsapp_phone_id')
        .eq('id', tenantId)
        .maybeSingle();
      if (data?.whatsapp_access_token && data?.whatsapp_phone_id) {
        return { token: data.whatsapp_access_token, phoneId: data.whatsapp_phone_id };
      }
    } catch (err) {
      console.warn('[WhatsApp] resolveCreds falló, uso env globales:', err);
    }
  }
  // Fallback: credenciales globales de env (tenant Principal / sin creds propias).
  return { token: getToken(), phoneId: getPhoneNumberId() };
}

function logApiError(context: string, err: any) {
  const status = err?.response?.status;
  const data   = err?.response?.data;
  const msg    = err?.message;
  console.error(
    `[${context}] Error API Facebook: status=${status}`,
    data ? JSON.stringify(data) : msg,
  );
}

// Devuelve el wamid (id del mensaje en WhatsApp) para poder matchear luego los
// webhooks de status (ticks) y reacciones. null si no vino en la respuesta.
export async function sendWhatsAppText(to: string, text: string, tenantId?: string): Promise<string | null> {
  const { token, phoneId } = await resolveCreds(tenantId);
  const headers     = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' };

  console.log(`[sendWhatsAppText] → ${to}: "${text.slice(0, 60)}"`);

  try {
    const res = await axios.post(
      `${BASE_URL}/${phoneId}/messages`,
      { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } },
      { headers },
    );
    const wamid = res.data?.messages?.[0]?.id ?? null;
    console.log(`[sendWhatsAppText] ✓ Enviado a ${to} wamid=${wamid}`);
    return wamid;
  } catch (err: any) {
    logApiError('sendWhatsAppText', err);
    throw err;
  }
}

export async function sendWhatsAppImage(to: string, imageUrl: string, caption: string, tenantId?: string) {
  const { token, phoneId } = await resolveCreds(tenantId);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' };

  try {
    await axios.post(
      `${BASE_URL}/${phoneId}/messages`,
      { messaging_product: 'whatsapp', to, type: 'image', image: { link: imageUrl, caption } },
      { headers },
    );
  } catch (err: any) {
    logApiError('sendWhatsAppImage', err);
    throw err;
  }
}

export async function sendWhatsAppTemplate(
  to: string,
  templateName: string,
  languageCode: string,
  variables: string[],
  phoneNumberId?: string,
  tenantId?: string,
) {
  const creds   = await resolveCreds(tenantId);
  const token   = creds.token;
  // Un phoneNumberId explícito (ej. plantilla con número dedicado) tiene prioridad
  // sobre el del tenant/env.
  const phoneId = phoneNumberId ?? creds.phoneId;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' };

  const body: any = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: { name: templateName, language: { code: languageCode } },
  };

  if (variables.length > 0) {
    body.template.components = [{
      type: 'body',
      parameters: variables.map((text) => ({ type: 'text', text })),
    }];
  }

  try {
    await axios.post(`${BASE_URL}/${phoneId}/messages`, body, { headers });
  } catch (err: any) {
    logApiError('sendWhatsAppTemplate', err);
    throw err;
  }
}

// Reacción a un mensaje del cliente (WhatsApp Reactions API).
// emoji = '' quita la reacción. messageId = wamid del mensaje a reaccionar.
export async function sendWhatsAppReaction(to: string, messageId: string, emoji: string) {
  const token   = getToken();
  const phoneId = getPhoneNumberId();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' };

  try {
    await axios.post(
      `${BASE_URL}/${phoneId}/messages`,
      { messaging_product: 'whatsapp', to, type: 'reaction', reaction: { message_id: messageId, emoji } },
      { headers },
    );
  } catch (err: any) {
    logApiError('sendWhatsAppReaction', err);
    throw err;
  }
}

export async function sendWhatsAppAudio(to: string, audioUrl: string, tenantId?: string) {
  const { token, phoneId } = await resolveCreds(tenantId);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' };

  try {
    await axios.post(
      `${BASE_URL}/${phoneId}/messages`,
      { messaging_product: 'whatsapp', to, type: 'audio', audio: { link: audioUrl } },
      { headers },
    );
  } catch (err: any) {
    logApiError('sendWhatsAppAudio', err);
    throw err;
  }
}

// Crea (registra) una plantilla de mensaje en Meta. Queda en revisión hasta que
// Meta la aprueba. El `example` se genera con un valor de muestra por cada
// placeholder {{n}} del cuerpo (requerido por Meta para plantillas con variables).
export async function createMessageTemplate(def: {
  name: string;
  language: string;
  category: string;
  bodyText: string;
}): Promise<any> {
  const token   = getToken();
  const wabaId  = getBusinessAccountId();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' };

  // Cantidad de placeholders distintos {{n}} en el cuerpo.
  const placeholders = new Set((def.bodyText.match(/\{\{(\d+)\}\}/g) ?? []));
  const sample = ['Juan', 'valor2', 'valor3', 'valor4'].slice(0, placeholders.size);

  const body: any = {
    name:     def.name,
    language: def.language,
    category: def.category,
    components: [
      {
        type: 'BODY',
        text: def.bodyText,
        ...(placeholders.size > 0 ? { example: { body_text: [sample] } } : {}),
      },
    ],
  };

  try {
    const res = await axios.post(`${BASE_URL}/${wabaId}/message_templates`, body, { headers });
    console.log(`[createMessageTemplate] ✓ "${def.name}" enviada a revisión:`, JSON.stringify(res.data));
    return res.data;
  } catch (err: any) {
    logApiError('createMessageTemplate', err);
    throw err;
  }
}

export async function fetchWhatsAppMediaUrl(mediaId: string): Promise<string> {
  const token   = getToken();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' };

  console.log(`[fetchWhatsAppMediaUrl] mediaId=${mediaId}`);

  try {
    const res = await axios.get(`${BASE_URL}/${mediaId}`, {
      headers,
      params: { fields: 'url' },
    });
    const url = res.data?.url as string;
    console.log(`[fetchWhatsAppMediaUrl] URL: ${url?.slice(0, 80)}`);
    return url;
  } catch (err: any) {
    logApiError('fetchWhatsAppMediaUrl', err);
    throw err;
  }
}
