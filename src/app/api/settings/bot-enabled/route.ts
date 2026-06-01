import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';

export async function GET() {
  const { data } = await supabaseAdmin
    .from('settings')
    .select('value')
    .eq('key', 'bot_enabled')
    .limit(1)
    .maybeSingle();

  const enabled = data?.value !== 'false';
  return NextResponse.json({ enabled });
}

export async function POST(request: Request) {
  const { enabled } = await request.json();
  const value     = enabled ? 'true'  : 'false';
  const modeValue = enabled ? 'bot'   : 'human';

  console.log(`[bot-enabled POST] enabled=${enabled} → bot_enabled="${value}" bot_mode="${modeValue}"`);

  // 1. Write bot_enabled (canonical key used by handler.ts)
  await supabaseAdmin.from('settings').delete().eq('key', 'bot_enabled');
  const { error: insError } = await supabaseAdmin
    .from('settings').insert({ key: 'bot_enabled', value });
  if (insError) {
    console.error('[bot-enabled POST] Insert bot_enabled error:', insError.message);
    return NextResponse.json({ ok: false, error: insError.message }, { status: 500 });
  }

  // 2. If bot_mode row exists in DB, keep it in sync too
  const { data: modeRow } = await supabaseAdmin
    .from('settings').select('key').eq('key', 'bot_mode').maybeSingle();
  if (modeRow) {
    await supabaseAdmin.from('settings').delete().eq('key', 'bot_mode');
    await supabaseAdmin.from('settings').insert({ key: 'bot_mode', value: modeValue });
    console.log(`[bot-enabled POST] bot_mode sincronizado → "${modeValue}"`);
  }

  // 3. Verify final state
  const { data: allRows } = await supabaseAdmin
    .from('settings').select('key, value').in('key', ['bot_enabled', 'bot_mode']);
  console.log('[bot-enabled POST] Estado final en DB:', JSON.stringify(allRows));

  return NextResponse.json({ ok: true, rows: allRows });
}
