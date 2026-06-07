import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { getSessionAgent } from '@/lib/current-agent';
import { irisSystemPrompt } from '@/lib/system-prompt';

const KEY = 'system_prompt';

export async function GET() {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });

  const { data } = await supabaseAdmin
    .from('settings')
    .select('value')
    .eq('key', KEY)
    .eq('tenant_id', session.tenant_id)
    .limit(1)
    .maybeSingle();

  // Fall back to hardcoded prompt if not yet saved in DB
  return NextResponse.json({ prompt: data?.value ?? irisSystemPrompt });
}

export async function POST(request: Request) {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });

  const { prompt } = await request.json();
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return new NextResponse('Prompt inválido', { status: 400 });
  }

  await supabaseAdmin.from('settings').delete().eq('key', KEY).eq('tenant_id', session.tenant_id);
  const { error } = await supabaseAdmin.from('settings').insert({ key: KEY, value: prompt.trim(), tenant_id: session.tenant_id });

  if (error) return new NextResponse(error.message, { status: 500 });
  return NextResponse.json({ ok: true });
}
