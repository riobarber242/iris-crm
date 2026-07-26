import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { supabaseAdmin } from '@/lib/db';
import { verifySession, signSession, COOKIE_NAME, MAX_AGE_SEC } from '@/lib/session';
import { normalizePlan } from '@/lib/plan';

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

  // Plan del tenant leído de la BASE, no del token: /me ya revalida contra la DB
  // en cada llamada, así que un cambio de plan se refleja en el menú sin esperar
  // a que el usuario vuelva a loguearse (el token puede vivir 7 días). El gate
  // duro del middleware sigue usando el del token; este es el de la UI.
  const tenantId = session.tenant_id ?? null;
  const { data: tenant } = tenantId
    ? await supabaseAdmin.from('tenants').select('plan').eq('id', tenantId).maybeSingle()
    : { data: null };

  const dbPlan = normalizePlan(tenant?.plan);

  const res = NextResponse.json({
    id:   agent.id,
    name: agent.name,
    role: agent.role,
    // tenant_id del token de sesión: lo necesita el browser para suscribirse al
    // canal de Realtime Broadcast por tenant (Fase 2). No es sensible para el
    // propio usuario (es su tenant). Sale de la sesión, no de un select nuevo.
    tenant_id: session.tenant_id ?? null,
    plan: dbPlan,
    can_see_top_clients: !!agent.can_see_top_clients,
    can_see_campaigns:   !!agent.can_see_campaigns,
    avatar_url: agent.avatar_url ?? null,
    phone:      agent.phone ?? null,
    session_timeout_enabled: agent.session_timeout_enabled ?? true,
    session_timeout_minutes: agent.session_timeout_minutes ?? 20,
  });

  // Re-firma de la cookie cuando el plan del token quedó viejo (cambio de plan
  // con sesiones abiertas). Sin esto el middleware —que decide con el token—
  // seguiría dejando pasar secciones que el cliente ya no tiene hasta que la
  // cookie expire (7 días); el guard server-side las tapa igual, pero recién en
  // la página, y ahí Next ya no puede devolver 404 (responde 200 con el cuerpo
  // del 404). El front llama a /me al navegar, al volver a la pestaña y cada
  // 30s, así que la ventana real es de segundos y el bloqueo vuelve a ser un
  // 404 de verdad en el middleware. Solo se re-firma ante un cambio: no hay
  // escritura de cookie en el caso normal.
  if (session.plan !== dbPlan) {
    console.log(`[auth/me] Plan desactualizado en la sesión (${session.plan ?? 'sin plan'} → ${dbPlan}): re-firmando cookie`);
    const token = await signSession({
      sub:       session.sub,
      name:      session.name,
      role:      session.role,
      tenant_id: session.tenant_id,
      plan:      dbPlan,
      can_see_top_clients: session.can_see_top_clients,
      can_see_campaigns:   session.can_see_campaigns,
    });
    res.cookies.set(COOKIE_NAME, token, {
      httpOnly: true,
      secure:   process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path:     '/',
      maxAge:   MAX_AGE_SEC,
    });
  }

  return res;
}
