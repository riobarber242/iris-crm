import axios from 'axios';

const whatsappToken = process.env.WHATSAPP_ACCESS_TOKEN;
const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
const baseUrl = 'https://graph.facebook.com/v18.0';

const headers = whatsappToken
  ? { Authorization: `Bearer ${whatsappToken}`, 'Content-Type': 'application/json' }
  : null;

export async function sendWhatsAppText(to: string, text: string) {
  if (!headers || !phoneNumberId) {
    throw new Error('WHATSAPP_ACCESS_TOKEN o WHATSAPP_PHONE_NUMBER_ID no configurados');
  }

  await axios.post(
    `${baseUrl}/${phoneNumberId}/messages`,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: {
        body: text,
      },
    },
    { headers }
  );
}

export async function sendWhatsAppImage(to: string, imageUrl: string, caption: string) {
  if (!headers || !phoneNumberId) {
    throw new Error('WHATSAPP_ACCESS_TOKEN o WHATSAPP_PHONE_NUMBER_ID no configurados');
  }

  await axios.post(
    `${baseUrl}/${phoneNumberId}/messages`,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'image',
      image: {
        link: imageUrl,
        caption,
      },
    },
    { headers }
  );
}

export async function fetchWhatsAppMediaUrl(mediaId: string) {
  if (!headers) {
    throw new Error('WHATSAPP_ACCESS_TOKEN no configurado');
  }

  const response = await axios.get(`${baseUrl}/${mediaId}`, {
    headers,
    params: { fields: 'url' },
  });

  return response.data?.url;
}
