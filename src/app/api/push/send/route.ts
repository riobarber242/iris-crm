import { NextRequest, NextResponse } from 'next/server';
import { notifyAgent } from '@/lib/push';

// POST interno: envía una notificación push a un agente puntual.
// body: { agentId, title, body, url }
export async function POST(req: NextRequest) {
  const { agentId, title, body, url } = await req.json();
  if (!agentId || !title) {
    return NextResponse.json({ error: 'agentId y title son requeridos' }, { status: 400 });
  }

  const sent = await notifyAgent(agentId, { title, body: body ?? '', url });
  return NextResponse.json({ ok: true, sent });
}
