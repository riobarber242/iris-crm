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

  await supabaseAdmin
    .from('settings')
    .upsert({ key: 'bot_enabled', value: enabled ? 'true' : 'false' });

  return NextResponse.json({ ok: true });
}
