import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { hashPassword } from '@/lib/auth';
import { requireAdmin } from '@/lib/current-agent';

const AGENT_FIELDS = 'id, username, name, role, active, schedule_start, schedule_end, created_at';

// GET /api/agents — lista de agentes (admin)
export async function GET() {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: 'Requiere rol admin' }, { status: 403 });
  }

  const { data, error } = await supabaseAdmin
    .from('agents')
    .select(AGENT_FIELDS)
    .order('created_at', { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data ?? []);
}

// POST /api/agents — crear agente (admin)
export async function POST(request: Request) {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: 'Requiere rol admin' }, { status: 403 });
  }

  let body: any;
  try { body = await request.json(); } catch { body = {}; }

  const username = String(body.username ?? '').trim().toLowerCase();
  const name     = String(body.name ?? '').trim();
  const password = String(body.password ?? '');
  const role     = body.role === 'admin' ? 'admin' : 'agent';
  const schedule_start = body.schedule_start || null;
  const schedule_end   = body.schedule_end   || null;

  if (!username || !name || !password) {
    return NextResponse.json({ error: 'Faltan usuario, nombre o contraseña' }, { status: 400 });
  }
  if (password.length < 6) {
    return NextResponse.json({ error: 'La contraseña debe tener al menos 6 caracteres' }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from('agents')
    .insert({
      username,
      name,
      password_hash: hashPassword(password),
      role,
      active: true,
      schedule_start,
      schedule_end,
    })
    .select(AGENT_FIELDS)
    .single();

  if (error) {
    // 23505 = unique_violation (username repetido)
    const msg = error.code === '23505' ? 'Ese usuario ya existe' : error.message;
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  return NextResponse.json(data);
}
