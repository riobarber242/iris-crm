import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { supabaseAdmin } from '@/lib/db';
import { verifySession, COOKIE_NAME } from '@/lib/session';

export async function GET() {
  const token   = (await cookies()).get(COOKIE_NAME)?.value;
  const session = await verifySession(token);
  if (!session) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }

  // Re-validate against DB so deactivation / deletion takes effect immediately
  const { data: agent } = await supabaseAdmin
    .from('agents')
    .select('id, name, role, active, can_see_top_clients, can_see_campaigns, avatar_url, phone, session_timeout_enabled, session_timeout_minutes')
    .eq('id', session.sub)
    .maybeSingle();

  if (!agent || !agent.active) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }

  return NextResponse.json({
    id:   agent.id,
    name: agent.name,
    role: agent.role,
    // tenant_id del token de sesión: lo necesita el browser para suscribirse al
    // canal de Realtime Broadcast por tenant (Fase 2). No es sensible para el
    // propio usuario (es su tenant). Sale de la sesión, no de un select nuevo.
    tenant_id: session.tenant_id ?? null,
    can_see_top_clients: !!agent.can_see_top_clients,
    can_see_campaigns:   !!agent.can_see_campaigns,
    avatar_url: agent.avatar_url ?? null,
    phone:      agent.phone ?? null,
    session_timeout_enabled: agent.session_timeout_enabled ?? true,
    session_timeout_minutes: agent.session_timeout_minutes ?? 20,
  });
}
