import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { requireAdmin } from '@/lib/current-agent';

const AGENT_FIELDS = 'id, username, name, role, active, schedule_start, schedule_end, created_at';

// PATCH /api/agents/[id] — editar agente (admin)
// Campos permitidos: name, role, active, schedule_start, schedule_end.
// (username inmutable; password se cambia en /api/agents/[id]/password)
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Requiere rol admin' }, { status: 403 });

  const { id } = await params;
  let body: any;
  try { body = await request.json(); } catch { body = {}; }

  const updates: Record<string, any> = {};
  if (body.name !== undefined)           updates.name           = String(body.name).trim();
  if (body.role !== undefined)           updates.role           = body.role === 'admin' ? 'admin' : 'agent';
  if (body.active !== undefined)         updates.active         = !!body.active;
  if (body.schedule_start !== undefined) updates.schedule_start = body.schedule_start || null;
  if (body.schedule_end !== undefined)   updates.schedule_end   = body.schedule_end   || null;

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'Nada para actualizar' }, { status: 400 });
  }

  // Salvaguarda anti-lockout: un admin no puede desactivarse ni quitarse el rol a sí mismo
  if (id === admin.sub) {
    if (updates.active === false) {
      return NextResponse.json({ error: 'No podés desactivar tu propia cuenta' }, { status: 400 });
    }
    if (updates.role === 'agent') {
      return NextResponse.json({ error: 'No podés quitarte el rol de admin a vos mismo' }, { status: 400 });
    }
  }

  const { data, error } = await supabaseAdmin
    .from('agents')
    .update(updates)
    .eq('id', id)
    .select(AGENT_FIELDS)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json(data);
}
