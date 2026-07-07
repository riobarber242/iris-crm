import { NextResponse } from 'next/server';
import { getSessionAgent } from '@/lib/current-agent';
import { tenantUsageSince } from '@/lib/campaigns/send-core';

// Uso diario (destinatarios únicos del tenant en la ventana móvil de 24h, todas las
// líneas). Barato (solo DB, sin llamada a Meta): el indicador "180/250 hoy" de la
// pantalla de Campañas lo pollea mientras hay un envío en curso.
const WINDOW_MS = 24 * 60 * 60 * 1000;

export async function GET() {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });

  const sinceISO = new Date(Date.now() - WINDOW_MS).toISOString();
  const usedToday = await tenantUsageSince(session.tenant_id, sinceISO);
  return NextResponse.json({ usedToday });
}
