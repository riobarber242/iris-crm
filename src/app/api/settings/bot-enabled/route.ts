import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { getSessionAgent } from '@/lib/current-agent';
import { logActivity, ACTIVITY } from '@/lib/activity-log';

export async function GET() {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });

  const { data } = await supabaseAdmin
    .from('settings')
    .select('value')
    .eq('key', 'bot_enabled')
    .eq('tenant_id', session.tenant_id)
    .limit(1)
    .maybeSingle();

  const enabled = data?.value !== 'false';
  return NextResponse.json({ enabled });
}

export async function POST(request: Request) {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });

  const { enabled } = await request.json();
  const value     = enabled ? 'true'  : 'false';
  const modeValue = enabled ? 'bot'   : 'human';
  const tenantId  = session.tenant_id;

  console.log(`[bot-enabled POST] tenant=${tenantId} enabled=${enabled} → bot_enabled="${value}" bot_mode="${modeValue}"`);

  // 1. Write bot_enabled (canonical key used by handler.ts) — scoped por tenant.
  await supabaseAdmin.from('settings').delete().eq('key', 'bot_enabled').eq('tenant_id', tenantId);
  const { error: insError } = await supabaseAdmin
    .from('settings').insert({ key: 'bot_enabled', value, tenant_id: tenantId });
  if (insError) {
    console.error('[bot-enabled POST] Insert bot_enabled error:', insError.message);
    return NextResponse.json({ ok: false, error: insError.message }, { status: 500 });
  }

  // 2. If bot_mode row exists for this tenant, keep it in sync too
  const { data: modeRow } = await supabaseAdmin
    .from('settings').select('key').eq('key', 'bot_mode').eq('tenant_id', tenantId).maybeSingle();
  if (modeRow) {
    await supabaseAdmin.from('settings').delete().eq('key', 'bot_mode').eq('tenant_id', tenantId);
    await supabaseAdmin.from('settings').insert({ key: 'bot_mode', value: modeValue, tenant_id: tenantId });
    console.log(`[bot-enabled POST] bot_mode sincronizado → "${modeValue}"`);
  }

  // 3. Verify final state (de este tenant)
  const { data: allRows } = await supabaseAdmin
    .from('settings').select('key, value').in('key', ['bot_enabled', 'bot_mode']).eq('tenant_id', tenantId);
  console.log('[bot-enabled POST] Estado final en DB:', JSON.stringify(allRows));

  // Registro de actividad: encender/apagar el bot.
  await logActivity({
    session,
    action:     ACTIVITY.CONFIG_CHANGED,
    objectType: 'config',
    objectId:   'bot_enabled',
    details:    { key: 'bot_enabled', enabled: !!enabled },
  });

  return NextResponse.json({ ok: true, rows: allRows });
}
