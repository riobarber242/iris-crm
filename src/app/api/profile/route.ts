import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { getSessionAgent } from '@/lib/current-agent';
import { signSession, COOKIE_NAME, MAX_AGE_SEC } from '@/lib/session';

// PATCH /api/profile — editar el PROPIO perfil (nombre y teléfono).
// El usuario sale SIEMPRE de la sesión (session.sub): no existe forma de
// apuntar a otro usuario, no se acepta ningún id del cliente.
export async function PATCH(request: Request) {
  const session = await getSessionAgent();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });

  let body: any;
  try { body = await request.json(); } catch { body = {}; }

  const updates: Record<string, any> = {};
  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) return NextResponse.json({ error: 'El nombre no puede quedar vacío' }, { status: 400 });
    if (name.length > 60) return NextResponse.json({ error: 'El nombre es demasiado largo (máx. 60)' }, { status: 400 });
    updates.name = name;
  }
  if (body.phone !== undefined) {
    const phone = String(body.phone).trim();
    if (phone && !/^[\d\s+\-()]{6,25}$/.test(phone)) {
      return NextResponse.json({ error: 'Teléfono inválido' }, { status: 400 });
    }
    updates.phone = phone || null;
  }
  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'Nada para actualizar' }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from('agents')
    .update(updates)
    .eq('id', session.sub)
    .select('id, name, phone, avatar_url')
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const res = NextResponse.json({ ok: true, profile: data });

  // Si cambió el nombre, re-firmamos la sesión para que los mensajes nuevos
  // salgan firmados con el nombre actualizado sin tener que re-loguear.
  if (updates.name && updates.name !== session.name) {
    const token = await signSession({
      sub: session.sub,
      name: updates.name,
      role: session.role,
      tenant_id: session.tenant_id,
      can_see_top_clients: session.can_see_top_clients,
      can_see_campaigns:   session.can_see_campaigns,
    });
    res.cookies.set(COOKIE_NAME, token, {
      httpOnly: true,
      secure:   process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path:     '/',
      maxAge:   MAX_AGE_SEC,
    });
  }

  return res;
}
