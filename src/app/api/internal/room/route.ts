import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { requireInternalMember, getOrCreateRoom, getOrCreateDmRoom } from '@/lib/internal-chat';

// GET /api/internal/room
//   (sin params) → get-or-create la sala GRUPAL del propio tenant.
//   ?dm=<agentId> → get-or-create el DM 1 a 1 con ese miembro. El par debe ser
//                   agente↔operador del MISMO tenant (no operador↔operador).
// Solo agent/operator (el admin de plataforma no participa). Scope por tenant.
export async function GET(request: Request) {
  const session = await requireInternalMember();
  if (!session) return NextResponse.json({ error: 'No autorizado' }, { status: 403 });

  const otherId = new URL(request.url).searchParams.get('dm');

  if (otherId) {
    if (otherId === session.sub) {
      return NextResponse.json({ error: 'No podés abrir un DM con vos mismo' }, { status: 400 });
    }
    // El otro miembro debe ser del mismo tenant y agent/operator.
    const { data: other } = await supabaseAdmin
      .from('agents')
      .select('id, role')
      .eq('id', otherId)
      .eq('tenant_id', session.tenant_id)
      .maybeSingle();
    if (!other || (other.role !== 'agent' && other.role !== 'operator')) {
      return NextResponse.json({ error: 'Destinatario inválido' }, { status: 404 });
    }
    // Alcance: solo agente↔operador (uno de cada rol).
    const roles = [session.role, other.role];
    if (!(roles.includes('agent') && roles.includes('operator'))) {
      return NextResponse.json({ error: 'El chat privado es solo entre agente y operador' }, { status: 403 });
    }

    const room = await getOrCreateDmRoom(session.tenant_id, session.sub, otherId);
    if (!room) return NextResponse.json({ error: 'No se pudo abrir el chat privado' }, { status: 500 });
    return NextResponse.json(room);
  }

  const room = await getOrCreateRoom(session.tenant_id);
  if (!room) return NextResponse.json({ error: 'No se pudo abrir la sala' }, { status: 500 });

  return NextResponse.json(room);
}
