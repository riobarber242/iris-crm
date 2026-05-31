import axios from 'axios';

const pixelId = process.env.META_PIXEL_ID;
const accessToken = process.env.META_CONVERSIONS_ACCESS_TOKEN;

export async function sendMetaPurchaseEvent(phone: string, value: number) {
  if (!pixelId || !accessToken) {
    console.warn('Meta Conversions no está configurada. No se envía el evento Purchase.');
    return;
  }

  const hashedPhone = hashPhone(phone);
  const payload = {
    data: [
      {
        event_name: 'Purchase',
        event_time: Math.floor(Date.now() / 1000),
        user_data: {
          phone: hashedPhone,
        },
        custom_data: {
          currency: 'ARS',
          value,
        },
      },
    ],
    access_token: accessToken,
  };

  await axios.post(`https://graph.facebook.com/v17.0/${pixelId}/events`, payload, {
    headers: { 'Content-Type': 'application/json' },
  });
}

function hashPhone(phone: string) {
  const normalized = phone.replace(/[^0-9]/g, '');
  return require('crypto').createHash('sha256').update(normalized).digest('hex');
}
