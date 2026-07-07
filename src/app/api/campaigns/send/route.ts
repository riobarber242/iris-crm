import { NextResponse } from 'next/server';
import { getSessionAgent } from '@/lib/current-agent';
import { runCampaignBatch } from '@/lib/campaigns/send-core';

// El envío hace sleeps entre mensajes (intervalo configurable + pausas). Subimos
// el límite de ejecución de la función para listas grandes. OJO: aun así el plan
// de Vercel impone un techo — para listas muy grandes conviene send_limit o
// trocear el envío (lo hace runCampaignBatch por presupuesto de tiempo).
export const maxDuration = 300;

export async function POST(request: Request) {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });

  const body = await request.json().catch(() => null);
  const campaignId = body?.campaignId as string | undefined;
  if (!campaignId) return new NextResponse('Falta campaignId', { status: 400 });

  // notifyOnPause: este es el envío interactivo (lanzado por el operador), así que
  // sí notificamos por push si se pausa. El cron de auto-resume no re-notifica.
  const result = await runCampaignBatch(campaignId, session.tenant_id, { notifyOnPause: true });

  if ('error' in result) return new NextResponse(result.error, { status: result.status });
  return NextResponse.json(result);
}
