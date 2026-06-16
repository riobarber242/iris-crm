import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { hashPassword } from '@/lib/auth';
import { requireAgentOrAdmin } from '@/lib/current-agent';

// POST /api/agents/[id]/password — resetear contraseña de un agente
//  - admin: cualquier agente.
//  - agent: solo operadores de su propio tenant.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAgentOrAdmin();
  if (!session) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 403 });
  }

  const { id } = await params;

  // El agente solo resetea la contraseña de operadores de su tenant.
  if (session.role === 'agent') {
    const { data: target } = await supabaseAdmin
      .from('agents')
      .select('id, role, tenant_id')
      .eq('id', id)
      .maybeSingle();
    if (!target || target.tenant_id !== session.tenant_id || target.role !== 'operator') {
      return NextResponse.json({ error: 'No autorizado' }, { status: 403 });
    }
  }

  let body: any;
  try { body = await request.json(); } catch { body = {}; }

  const password = String(body.password ?? '');
  if (password.length < 6) {
    return NextResponse.json({ error: 'La contraseña debe tener al menos 6 caracteres' }, { status: 400 });
  }

  const { error } = await supabaseAdmin
    .from('agents')
    .update({ password_hash: hashPassword(password) })
    .eq('id', id);

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
