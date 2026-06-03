import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { supabaseAdmin } from '@/lib/db';
import { verifySession, COOKIE_NAME } from '@/lib/session';

export async function GET() {
  const token   = (await cookies()).get(COOKIE_NAME)?.value;
  const session = await verifySession(token);
  if (!session) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }

  // Re-validate against DB so deactivation / deletion takes effect immediately
  const { data: agent } = await supabaseAdmin
    .from('agents')
    .select('id, name, role, active')
    .eq('id', session.sub)
    .maybeSingle();

  if (!agent || !agent.active) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }

  return NextResponse.json({ id: agent.id, name: agent.name, role: agent.role });
}
