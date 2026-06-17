import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { requireInternalMember, resolveRoom } from '@/lib/internal-chat';

// GET /api/internal/unread?roomId= — nº de mensajes NO leídos por este miembro
// en la sala: mensajes de OTROS autores con created_at > su last_read_at.
// Si nunca leyó la sala, cuenta todos los mensajes de otros. Scope por tenant.
export async function GET(request: Request) {
  const session = await requireInternalMember();
  if (!session) return NextResponse.json({ error: 'No autorizado' }, { status: 403 });

  const url = new URL(request.url);
  const room = await resolveRoom(session.tenant_id, url.searchParams.get('roomId'));
  if (!room) return NextResponse.json({ unread: 0 });

  // Último momento de lectura de ESTE miembro (null = nunca leyó).
  const { data: readRow } = await supabaseAdmin
    .from('internal_room_reads')
    .select('last_read_at')
    .eq('room_id', room.id)
    .eq('agent_id', session.sub)
    .maybeSingle();

  let query = supabaseAdmin
    .from('internal_messages')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', session.tenant_id)
    .eq('room_id', room.id)
    .neq('author_id', session.sub); // los propios no cuentan como no-leídos

  if (readRow?.last_read_at) {
    query = query.gt('created_at', readRow.last_read_at);
  }

  const { count, error } = await query;
  if (error) return NextResponse.json({ unread: 0 });

  return NextResponse.json({ roomId: room.id, unread: count ?? 0 });
}
