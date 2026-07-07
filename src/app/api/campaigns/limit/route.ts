import { NextResponse } from 'next/server';
import { getSessionAgent } from '@/lib/current-agent';
import { getMessagingLimit } from '@/lib/meta/client';
import { tenantUsageSince } from '@/lib/campaigns/send-core';

// Límite diario REAL de Meta para el tenant + uso ya consumido en la ventana móvil
// de 24h. Lo consume el paso "Confirmar" del wizard para proponer el techo por
// defecto (80% del límite) y mostrar cuánto queda. Hace 1 llamada a Meta, así que
// NO conviene pollearlo (para el indicador en vivo usar /api/campaigns/usage).
const WINDOW_MS = 24 * 60 * 60 * 1000;

export async function GET() {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });

  const sinceISO = new Date(Date.now() - WINDOW_MS).toISOString();
  const [{ tier, limit }, usedToday] = await Promise.all([
    getMessagingLimit(session.tenant_id),
    tenantUsageSince(session.tenant_id, sinceISO),
  ]);

  return NextResponse.json({ tier, metaLimit: limit, usedToday });
}
