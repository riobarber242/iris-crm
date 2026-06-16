import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { requireAdmin } from '@/lib/current-agent';

const AGENT_FIELDS = 'id, username, name, email, role, active, schedule_start, schedule_end, system_prompt, can_see_top_clients, can_see_campaigns, session_timeout_enabled, session_timeout_minutes, sueldo_diario, created_at';

// PATCH /api/agents/[id] — editar agente (admin)
// Campos permitidos: name, email, role, active, schedule_start, schedule_end,
// system_prompt, can_see_top_clients, can_see_campaigns,
// session_timeout_enabled, session_timeout_minutes.
// (username inmutable; password se cambia en /api/agents/[id]/password)
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Requiere rol admin' }, { status: 403 });

  const { id } = await params;
  let body: any;
  try { body = await request.json(); } catch { body = {}; }

  const updates: Record<string, any> = {};
  if (body.name !== undefined)           updates.name           = String(body.name).trim();
  if (body.email !== undefined)          updates.email          = String(body.email).trim() || null;
  if (body.role !== undefined)           updates.role           = ['admin', 'operator'].includes(body.role) ? body.role : 'agent';
  if (body.active !== undefined)         updates.active         = !!body.active;
  if (body.schedule_start !== undefined) updates.schedule_start = body.schedule_start || null;
  if (body.schedule_end !== undefined)   updates.schedule_end   = body.schedule_end   || null;
  if (body.system_prompt !== undefined)  updates.system_prompt  = String(body.system_prompt);
  if (body.can_see_top_clients !== undefined) updates.can_see_top_clients = !!body.can_see_top_clients;
  if (body.can_see_campaigns !== undefined)   updates.can_see_campaigns   = !!body.can_see_campaigns;
  if (body.session_timeout_enabled !== undefined) updates.session_timeout_enabled = !!body.session_timeout_enabled;
  if (body.session_timeout_minutes !== undefined) {
    const n = Number(body.session_timeout_minutes);
    if (!Number.isInteger(n) || n < 1 || n > 1440) {
      return NextResponse.json({ error: 'Los minutos de cierre de sesión deben ser un entero entre 1 y 1440' }, { status: 400 });
    }
    updates.session_timeout_minutes = n;
  }
  // Sueldo diario del operador (Etapa 5): entero ≥ 0.
  if (body.sueldo_diario !== undefined) {
    const n = Number(body.sueldo_diario);
    if (!Number.isInteger(n) || n < 0) {
      return NextResponse.json({ error: 'El sueldo diario debe ser un entero mayor o igual a 0' }, { status: 400 });
    }
    updates.sueldo_diario = n;
  }

  // Si se cambia el rol a algo que no es 'operator', limpiamos los permisos
  // opcionales (admin/agent ya ven todo; no tiene sentido dejar flags colgados).
  if (updates.role !== undefined && updates.role !== 'operator') {
    updates.can_see_top_clients = false;
    updates.can_see_campaigns   = false;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'Nada para actualizar' }, { status: 400 });
  }

  // Salvaguarda anti-lockout: un admin no puede desactivarse ni quitarse el rol a sí mismo
  if (id === admin.sub) {
    if (updates.active === false) {
      return NextResponse.json({ error: 'No podés desactivar tu propia cuenta' }, { status: 400 });
    }
    if (updates.role !== undefined && updates.role !== 'admin') {
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

// DELETE /api/agents/[id] — eliminar agente (admin)
// Antes de borrar, desasigna: chats (contacts.assigned_agent_id) y autoría de
// mensajes (messages.agent_id) quedan en null. El nombre del agente en cada
// mensaje (agent_name) se conserva como snapshot histórico.
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Requiere rol admin' }, { status: 403 });

  const { id } = await params;

  // Salvaguarda anti-lockout: no podés borrarte a vos mismo
  if (id === admin.sub) {
    return NextResponse.json({ error: 'No podés eliminar tu propia cuenta' }, { status: 400 });
  }

  // Desasignar dependencias para no violar las FKs (defensa en profundidad,
  // independiente de la acción ON DELETE configurada en la DB).
  await supabaseAdmin.from('contacts').update({ assigned_agent_id: null }).eq('assigned_agent_id', id);
  await supabaseAdmin.from('messages').update({ agent_id: null }).eq('agent_id', id);

  const { error } = await supabaseAdmin.from('agents').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ ok: true });
}
