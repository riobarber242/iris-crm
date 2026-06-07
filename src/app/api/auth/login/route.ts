import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { verifyPassword } from '@/lib/auth';
import { signSession, COOKIE_NAME, MAX_AGE_SEC } from '@/lib/session';
import { checkRateLimit } from '@/lib/ratelimit';

export async function POST(request: Request) {
  const limited = checkRateLimit(request, 'login', 10);
  if (limited) return limited;

  let body: any;
  try { body = await request.json(); } catch { body = {}; }
  const username = String(body.username ?? '').trim();
  const password = String(body.password ?? '');

  if (!username || !password) {
    return NextResponse.json({ error: 'Faltan usuario o contraseña' }, { status: 400 });
  }

  const { data: agent } = await supabaseAdmin
    .from('agents')
    .select('id, username, password_hash, name, role, active, tenant_id')
    .eq('username', username)
    .maybeSingle();

  // Generic message for unknown user / bad password (no enumeration)
  if (!agent || !verifyPassword(password, agent.password_hash)) {
    return NextResponse.json({ error: 'Usuario o contraseña inválidos' }, { status: 401 });
  }

  // Only revealed after a correct password → the legit agent learns they're disabled
  if (!agent.active) {
    return NextResponse.json({ error: 'Tu cuenta está desactivada. Contactá al administrador.' }, { status: 403 });
  }

  const token = await signSession({ sub: agent.id, name: agent.name, role: agent.role, tenant_id: agent.tenant_id ?? '00000000-0000-0000-0000-000000000001' });

  const res = NextResponse.json({ id: agent.id, name: agent.name, role: agent.role });
  res.cookies.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path:     '/',
    maxAge:   MAX_AGE_SEC,
  });
  return res;
}
