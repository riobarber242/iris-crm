import axios from 'axios';

const whatsappToken = process.env.WHATSAPP_ACCESS_TOKEN;
const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
const baseUrl = 'https://graph.facebook.com/v17.0';

if (!whatsappToken) {
  throw new Error('Falta WHATSAPP_ACCESS_TOKEN en las variables de entorno');
}

if (!phoneNumberId) {
  throw new Error('Falta WHATSAPP_PHONE_NUMBER_ID en las variables de entorno');
}

const headers = {
  Authorization: `Bearer ${whatsappToken}`,
  'Content-Type': 'application/json',
};

export async function sendWhatsAppText(to: string, text: string) {
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
