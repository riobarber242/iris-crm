import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { getSessionAgent } from '@/lib/current-agent';

const KEY = 'auto_verificacion_msg';

export async function GET() {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });

  const { data } = await supabaseAdmin
    .from('settings').select('value').eq('key', KEY).eq('tenant_id', session.tenant_id).limit(1).maybeSingle();
  return NextResponse.json({ enabled: data?.value !== 'false' });
}

export async function POST(request: Request) {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });

  const { enabled } = await request.json();
  const value = enabled ? 'true' : 'false';
  await supabaseAdmin.from('settings').delete().eq('key', KEY).eq('tenant_id', session.tenant_id);
  await supabaseAdmin.from('settings').insert({ key: KEY, value, tenant_id: session.tenant_id });
  return NextResponse.json({ ok: true });
}
