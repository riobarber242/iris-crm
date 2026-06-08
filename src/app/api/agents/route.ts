import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { hashPassword } from '@/lib/auth';
import { requireAdmin } from '@/lib/current-agent';

const AGENT_FIELDS = 'id, username, name, email, role, active, schedule_start, schedule_end, system_prompt, can_see_top_clients, can_see_campaigns, created_at';

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
  const admin = await requireAdmin();
  if (!admin) {
    return NextResponse.json({ error: 'Requiere rol admin' }, { status: 403 });
  }

  let body: any;
  try { body = await request.json(); } catch { body = {}; }

  const username = String(body.username ?? '').trim().toLowerCase();
  const name     = String(body.name ?? '').trim();
  const email    = String(body.email ?? '').trim() || null;
  const password = String(body.password ?? '');
  const role     = ['admin', 'operator'].includes(body.role) ? body.role : 'agent';
  const schedule_start = body.schedule_start || null;
  const schedule_end   = body.schedule_end   || null;
  const system_prompt  = body.system_prompt != null ? String(body.system_prompt) : null;
  // Permisos opcionales — solo tienen efecto para el rol 'operator'.
  // En cualquier otro rol los guardamos en false (admin/agent ya ven todo).
  const can_see_top_clients = role === 'operator' && !!body.can_see_top_clients;
  const can_see_campaigns   = role === 'operator' && !!body.can_see_campaigns;

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
      email,
      password_hash: hashPassword(password),
      role,
      active: true,
      schedule_start,
      schedule_end,
      system_prompt,
      can_see_top_clients,
      can_see_campaigns,
      // Multi-tenant: el nuevo agente hereda el tenant del admin que lo crea.
      tenant_id: admin.tenant_id,
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
