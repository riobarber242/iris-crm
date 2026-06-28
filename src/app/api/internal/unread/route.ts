import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { requireInternalMember, resolveRoom, countRoomUnread } from '@/lib/internal-chat';

// GET /api/internal/unread?roomId= — nº de mensajes NO leídos por este miembro.
//  · con roomId  → no-leídos de ESA sala (mensajes de otros con created_at > su
//    last_read_at). Valida pertenencia (en DM, solo participantes).
//  · sin roomId  → SUMA de no-leídos de TODAS mis salas (grupo + mis DMs), para
//    el badge del sidebar. Devuelve además el desglose por sala (byRoom).
// Scope estricto por tenant.
export async function GET(request: Request) {
  const session = await requireInternalMember();
  if (!session) return NextResponse.json({ error: 'No autorizado' }, { status: 403 });

  const roomIdParam = new URL(request.url).searchParams.get('roomId');

  // ── Modo por-sala (comportamiento original) ────────────────────────────────
  if (roomIdParam) {
    const room = await resolveRoom(session.tenant_id, roomIdParam, session.sub);
    if (!room) return NextResponse.json({ unread: 0 });
    const unread = await countRoomUnread(session.tenant_id, room.id, session.sub);
    return NextResponse.json({ roomId: room.id, unread });
  }

  // ── Modo agregado: todas mis salas (grupo del tenant + mis DMs) ────────────
  const { data: rooms } = await supabaseAdmin
    .from('internal_rooms')
    .select('id, kind, participant_a, participant_b')
    .eq('tenant_id', session.tenant_id)
    .or(`kind.eq.group,participant_a.eq.${session.sub},participant_b.eq.${session.sub}`);

  const byRoom: Record<string, number> = {};
  let total = 0;
  for (const r of rooms ?? []) {
    const n = await countRoomUnread(session.tenant_id, r.id, session.sub);
    byRoom[r.id] = n;
    total += n;
  }
  return NextResponse.json({ unread: total, byRoom });
}
