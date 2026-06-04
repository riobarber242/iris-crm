import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';

// Modo OFFLINE: cuando está activo, el bot responde a TODOS los mensajes con un
// aviso de "no estamos operando" y no hace onboarding ni handoff. Default: false.
export async function GET() {
  const { data } = await supabaseAdmin
    .from('settings')
    .select('value')
    .eq('key', 'offline_mode')
    .limit(1)
    .maybeSingle();

  const offline = data?.value === 'true';
  return NextResponse.json({ offline });
}

export async function POST(request: Request) {
  const { offline } = await request.json();
  const value = offline ? 'true' : 'false';

  console.log(`[offline-mode POST] offline=${offline} → offline_mode="${value}"`);

  await supabaseAdmin.from('settings').delete().eq('key', 'offline_mode');
  const { error } = await supabaseAdmin.from('settings').insert({ key: 'offline_mode', value });
  if (error) {
    console.error('[offline-mode POST] Insert error:', error.message);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, offline });
}
