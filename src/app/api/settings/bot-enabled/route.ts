import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';

export async function GET() {
  const { data } = await supabaseAdmin
    .from('settings')
    .select('value')
    .eq('key', 'bot_enabled')
    .single();

  const enabled = data?.value !== 'false';
  return NextResponse.json({ enabled });
}

export async function POST(request: Request) {
  const { enabled } = await request.json();
  const value = enabled ? 'true' : 'false';

  console.log(`[bot-enabled POST] Setting bot_enabled → ${value}`);

  const { error } = await supabaseAdmin
    .from('settings')
    .upsert({ key: 'bot_enabled', value }, { onConflict: 'key' });

  if (error) {
    console.error('[bot-enabled POST] Upsert error:', error.message);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  // Verify what actually ended up in the DB
  const { data: verify } = await supabaseAdmin
    .from('settings')
    .select('value')
    .eq('key', 'bot_enabled')
    .maybeSingle();

  console.log(`[bot-enabled POST] Verified in DB: ${JSON.stringify(verify?.value)}`);

  return NextResponse.json({ ok: true, stored: verify?.value });
}
