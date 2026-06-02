import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';

const KEY = 'auto_verificacion_msg';

export async function GET() {
  const { data } = await supabaseAdmin
    .from('settings').select('value').eq('key', KEY).limit(1).maybeSingle();
  return NextResponse.json({ enabled: data?.value !== 'false' });
}

export async function POST(request: Request) {
  const { enabled } = await request.json();
  const value = enabled ? 'true' : 'false';
  await supabaseAdmin.from('settings').delete().eq('key', KEY);
  await supabaseAdmin.from('settings').insert({ key: KEY, value });
  return NextResponse.json({ ok: true });
}
