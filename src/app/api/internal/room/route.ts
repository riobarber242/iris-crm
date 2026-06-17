import { NextResponse } from 'next/server';
import { requireInternalMember, getOrCreateRoom } from '@/lib/internal-chat';

// GET /api/internal/room — get-or-create la sala del PROPIO tenant.
// Solo agent/operator (el admin de plataforma no participa). Scope por tenant.
export async function GET() {
  const session = await requireInternalMember();
  if (!session) return NextResponse.json({ error: 'No autorizado' }, { status: 403 });

  const room = await getOrCreateRoom(session.tenant_id);
  if (!room) return NextResponse.json({ error: 'No se pudo abrir la sala' }, { status: 500 });

  return NextResponse.json(room);
}
