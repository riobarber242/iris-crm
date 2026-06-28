import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { getSessionAgent } from '@/lib/current-agent';

// Guarda (upsert por agent_id) la suscripción push del navegador del agente.
// El agent_id se toma de la SESIÓN, no del body: así nadie puede registrar/pisar
// la suscripción de otro usuario pasando un agentId ajeno.
export async function POST(req: NextRequest) {
  try {
    const session = await getSessionAgent();
    if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });

    const body = await req.json().catch(() => null);
    const { subscription } = body ?? {};
    if (!subscription) {
      return NextResponse.json({ error: 'subscription es requerida' }, { status: 400 });
    }

    // Una fila por DISPOSITIVO: la clave es el endpoint de la suscripción, no el
    // agente. Así el celular y el desktop del mismo operador conviven y ninguno
    // pisa al otro (push multi-dispositivo). Sin endpoint no podemos deduplicar.
    const endpoint = subscription?.endpoint;
    if (!endpoint) {
      return NextResponse.json({ error: 'subscription sin endpoint' }, { status: 400 });
    }

    const { error } = await supabaseAdmin
      .from('push_subscriptions')
      .upsert({ agent_id: session.sub, endpoint, subscription }, { onConflict: 'endpoint' });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error('[push/subscribe POST] Error inesperado:', err);
    return NextResponse.json({ error: 'Error interno guardando la suscripción' }, { status: 500 });
  }
}
