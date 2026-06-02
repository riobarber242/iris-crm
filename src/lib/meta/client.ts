import axios from 'axios';

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

function logApiError(context: string, err: any) {
  const status = err?.response?.status;
  const data   = err?.response?.data;
  const msg    = err?.message;
  console.error(
    `[${context}] Error API Facebook: status=${status}`,
    data ? JSON.stringify(data) : msg,
  );
}

export async function sendWhatsAppText(to: string, text: string) {
  const token       = getToken();
  const phoneId     = getPhoneNumberId();
  const headers     = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  console.log(`[sendWhatsAppText] → ${to}: "${text.slice(0, 60)}"`);

  try {
    await axios.post(
      `${BASE_URL}/${phoneId}/messages`,
      { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } },
      { headers },
    );
    console.log(`[sendWhatsAppText] ✓ Enviado a ${to}`);
  } catch (err: any) {
    logApiError('sendWhatsAppText', err);
    throw err;
  }
}

export async function sendWhatsAppImage(to: string, imageUrl: string, caption: string) {
  const token   = getToken();
  const phoneId = getPhoneNumberId();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

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
) {
  const token   = getToken();
  const phoneId = getPhoneNumberId();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

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

export async function sendWhatsAppAudio(to: string, audioUrl: string) {
  const token   = getToken();
  const phoneId = getPhoneNumberId();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

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

export async function fetchWhatsAppMediaUrl(mediaId: string): Promise<string> {
  const token   = getToken();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

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
