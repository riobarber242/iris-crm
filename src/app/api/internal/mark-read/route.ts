import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { requireInternalMember, resolveRoom } from '@/lib/internal-chat';

// POST /api/internal/mark-read — marca la sala como leída para ESTE miembro.
// body: { roomId? }. Upsert en internal_room_reads (last_read_at = now()).
// Scope estricto por tenant + sala del tenant.
export async function POST(request: Request) {
  const session = await requireInternalMember();
  if (!session) return NextResponse.json({ error: 'No autorizado' }, { status: 403 });

  const body = await request.json().catch(() => ({} as any));
  const room = await resolveRoom(session.tenant_id, body?.roomId ?? null, session.sub);
  if (!room) return new NextResponse('Sala no encontrada', { status: 404 });

  const { error } = await supabaseAdmin
    .from('internal_room_reads')
    .upsert(
      {
        tenant_id:    session.tenant_id,
        room_id:      room.id,
        agent_id:     session.sub,
        last_read_at: new Date().toISOString(),
      },
      { onConflict: 'room_id,agent_id' },
    );

  if (error) return new NextResponse(error.message, { status: 500 });
  return NextResponse.json({ ok: true });
}
