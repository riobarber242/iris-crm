import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { getSessionAgent } from '@/lib/current-agent';
import { logActivity, ACTIVITY } from '@/lib/activity-log';

// Modo OFFLINE: cuando está activo, el bot responde a TODOS los mensajes con un
// aviso de "no estamos operando" y no hace onboarding ni handoff. Default: false.
export async function GET() {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });

  const { data } = await supabaseAdmin
    .from('settings')
    .select('value')
    .eq('key', 'offline_mode')
    .eq('tenant_id', session.tenant_id)
    .limit(1)
    .maybeSingle();

  const offline = data?.value === 'true';
  return NextResponse.json({ offline });
}

export async function POST(request: Request) {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });

  const { offline } = await request.json();
  const value = offline ? 'true' : 'false';
  const tenantId = session.tenant_id;

  console.log(`[offline-mode POST] tenant=${tenantId} offline=${offline} → offline_mode="${value}"`);

  await supabaseAdmin.from('settings').delete().eq('key', 'offline_mode').eq('tenant_id', tenantId);
  const { error } = await supabaseAdmin.from('settings').insert({ key: 'offline_mode', value, tenant_id: tenantId });
  if (error) {
    console.error('[offline-mode POST] Insert error:', error.message);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  // Registro de actividad: activar/desactivar modo offline.
  await logActivity({
    session,
    action:     ACTIVITY.CONFIG_CHANGED,
    objectType: 'config',
    objectId:   'offline_mode',
    details:    { key: 'offline_mode', offline: !!offline },
  });

  return NextResponse.json({ ok: true, offline });
}
