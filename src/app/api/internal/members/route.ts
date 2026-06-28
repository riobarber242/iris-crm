import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { requireInternalMember, countRoomUnread } from '@/lib/internal-chat';

// GET /api/internal/members — contrapartes con las que puedo abrir un DM.
// Alcance agente↔operador:
//   · agente   → ve a sus operadores activos.
//   · operador → ve al/los agente(s) del tenant.
// Devuelve id, name, role, avatar_url, dm_room_id (si ya existe) y unread.
// Scope estricto por tenant.
export async function GET() {
  const session = await requireInternalMember();
  if (!session) return NextResponse.json({ error: 'No autorizado' }, { status: 403 });

  const me = session.sub;
  const targetRole = session.role === 'agent' ? 'operator' : 'agent';

  let query = supabaseAdmin
    .from('agents')
    .select('id, name, role, avatar_url')
    .eq('tenant_id', session.tenant_id)
    .eq('role', targetRole)
    .neq('id', me)
    .order('name', { ascending: true });
  // Solo operadores activos (para el agente). Los agentes se listan siempre.
  if (targetRole === 'operator') query = query.eq('active', true);

  const { data: members, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Mis DMs ya existentes → mapear contraparte → room_id (para badge y apertura).
  const { data: dmRooms } = await supabaseAdmin
    .from('internal_rooms')
    .select('id, participant_a, participant_b')
    .eq('tenant_id', session.tenant_id)
    .eq('kind', 'dm')
    .or(`participant_a.eq.${me},participant_b.eq.${me}`);

  const roomByOther = new Map<string, string>();
  for (const r of dmRooms ?? []) {
    const other = r.participant_a === me ? r.participant_b : r.participant_a;
    if (other) roomByOther.set(other, r.id);
  }

  const enriched = await Promise.all((members ?? []).map(async (m: any) => {
    const dmRoomId = roomByOther.get(m.id) ?? null;
    const unread = dmRoomId ? await countRoomUnread(session.tenant_id, dmRoomId, me) : 0;
    return { ...m, dm_room_id: dmRoomId, unread };
  }));

  return NextResponse.json(enriched);
}
