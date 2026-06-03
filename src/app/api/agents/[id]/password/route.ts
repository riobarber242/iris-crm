import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { hashPassword } from '@/lib/auth';
import { requireAdmin } from '@/lib/current-agent';

// POST /api/agents/[id]/password — resetear contraseña de un agente (admin)
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: 'Requiere rol admin' }, { status: 403 });
  }

  const { id } = await params;
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
