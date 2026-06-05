import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';

// Guarda (upsert por agent_id) la suscripción push del navegador del agente.
export async function POST(req: NextRequest) {
  const { subscription, agentId } = await req.json();
  if (!subscription || !agentId) {
    return NextResponse.json({ error: 'subscription y agentId son requeridos' }, { status: 400 });
  }

  const { error } = await supabaseAdmin
    .from('push_subscriptions')
    .upsert({ agent_id: agentId, subscription }, { onConflict: 'agent_id' });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
