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
  const value = enabled ? 'true' : 'false';

  console.log(`[bot-enabled POST] Setting bot_enabled → ${value}`);

  // DELETE + INSERT: more reliable than upsert (no unique constraint required)
  const { error: delError } = await supabaseAdmin
    .from('settings')
    .delete()
    .eq('key', 'bot_enabled');

  if (delError) {
    console.error('[bot-enabled POST] Delete error:', delError.message);
  }

  const { error: insError } = await supabaseAdmin
    .from('settings')
    .insert({ key: 'bot_enabled', value });

  if (insError) {
    console.error('[bot-enabled POST] Insert error:', insError.message);
    return NextResponse.json({ ok: false, error: insError.message }, { status: 500 });
  }

  // Verify what actually ended up in the DB
  const { data: verify } = await supabaseAdmin
    .from('settings')
    .select('value')
    .eq('key', 'bot_enabled')
    .limit(1)
    .maybeSingle();

  console.log(`[bot-enabled POST] Verified in DB: ${JSON.stringify(verify?.value)}`);

  return NextResponse.json({ ok: true, stored: verify?.value });
}
