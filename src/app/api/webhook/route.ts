import { NextResponse } from 'next/server';
import { handleWhatsappWebhook } from '@/lib/meta/handler';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return new NextResponse(challenge ?? '', {
      status: 200,
      headers: {
        'Bypass-Tunnel-Reminder': 'bypass',
      },
    });
  }

  return new NextResponse('Verificación fallida', {
    status: 403,
    headers: {
      'Bypass-Tunnel-Reminder': 'bypass',
    },
  });
}

export async function POST(request: Request) {
  const rawBody = await request.text();
  const signature = request.headers.get('x-hub-signature-256') ?? undefined;

  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch (error) {
    return new NextResponse('JSON inválido', {
      status: 400,
      headers: {
        'Bypass-Tunnel-Reminder': 'bypass',
      },
    });
  }

  const result = await handleWhatsappWebhook(rawBody, signature, payload);
  return new NextResponse(result.body, {
    status: result.status,
    headers: {
      'Bypass-Tunnel-Reminder': 'bypass',
    },
  });
}
