import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { irisSystemPrompt } from '@/lib/system-prompt';

const KEY = 'system_prompt';

export async function GET() {
  const { data } = await supabaseAdmin
    .from('settings')
    .select('value')
    .eq('key', KEY)
    .limit(1)
    .maybeSingle();

  // Fall back to hardcoded prompt if not yet saved in DB
  return NextResponse.json({ prompt: data?.value ?? irisSystemPrompt });
}

export async function POST(request: Request) {
  const { prompt } = await request.json();
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return new NextResponse('Prompt inválido', { status: 400 });
  }

  await supabaseAdmin.from('settings').delete().eq('key', KEY);
  const { error } = await supabaseAdmin.from('settings').insert({ key: KEY, value: prompt.trim() });

  if (error) return new NextResponse(error.message, { status: 500 });
  return NextResponse.json({ ok: true });
}
