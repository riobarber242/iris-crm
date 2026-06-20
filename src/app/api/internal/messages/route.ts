import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { checkRateLimit } from '@/lib/ratelimit';
import { requireInternalMember, resolveRoom } from '@/lib/internal-chat';

// Mensajes del chat interno del equipo. NO sale a WhatsApp/Meta.
// Aislamiento estricto: todo filtra por session.tenant_id y por una sala que
// pertenece a ese tenant. Solo agent/operator (el admin de plataforma no entra).

// GET /api/internal/messages?roomId= — lista los mensajes de la sala (desc).
// roomId es opcional: si falta, usa (o crea) la sala del tenant. Enriquece cada
// mensaje con el avatar actual del autor (igual que /api/messages).
export async function GET(request: Request) {
  const session = await requireInternalMember();
  if (!session) return NextResponse.json({ error: 'No autorizado' }, { status: 403 });

  const url = new URL(request.url);
  const room = await resolveRoom(session.tenant_id, url.searchParams.get('roomId'));
  if (!room) return new NextResponse('Sala no encontrada', { status: 404 });

  const { data, error } = await supabaseAdmin
    .from('internal_messages')
    .select('*')
    .eq('tenant_id', session.tenant_id)
    .eq('room_id', room.id)
    .order('created_at', { ascending: false });

  if (error) return new NextResponse(error.message, { status: 500 });

  // Avatar actual del autor (en vivo, con service-role para no exponer /api/agents).
  const authorIds = [
    ...new Set((data ?? [])
      .filter((m: any) => m.author_id)
      .map((m: any) => m.author_id as string)),
  ];
  let avatarById: Record<string, string | null> = {};
  if (authorIds.length) {
    const { data: ags } = await supabaseAdmin
      .from('agents')
      .select('id, avatar_url')
      .in('id', authorIds);
    avatarById = Object.fromEntries((ags ?? []).map((a: any) => [a.id, a.avatar_url ?? null]));
  }

  // Estado real de los comprobantes de cierre referenciados por mensajes
  // 'traspaso' (content JSON {_type:'traspaso', comprobante_id}). Así el front
  // sabe si ya fue verificado/rechazado y no muestra los botones tras un reload.
  function comprobanteIdDe(content: string): string | null {
    try {
      const p = JSON.parse(content);
      if (p?._type === 'traspaso' && typeof p.comprobante_id === 'string') return p.comprobante_id;
    } catch {}
    return null;
  }
  const compIds = [
    ...new Set((data ?? [])
      .map((m: any) => comprobanteIdDe(m.content))
      .filter((id: string | null): id is string => !!id)),
  ];
  let estadoById: Record<string, string> = {};
  if (compIds.length) {
    const { data: comps } = await supabaseAdmin
      .from('comprobantes')
      .select('id, estado')
      .eq('tenant_id', session.tenant_id)
      .in('id', compIds);
    estadoById = Object.fromEntries((comps ?? []).map((c: any) => [c.id, c.estado]));
  }

  const enriched = (data ?? []).map((m: any) => {
    const out = m.author_id ? { ...m, author_avatar: avatarById[m.author_id] ?? null } : { ...m };
    const cid = comprobanteIdDe(m.content);
    if (cid) out.traspaso_estado = estadoById[cid] ?? null;
    return out;
  });

  return NextResponse.json(enriched);
}

// POST /api/internal/messages — mensaje de TEXTO. body: { content, roomId? }.
// El autor se deriva de la cookie de sesión, nunca del cliente.
export async function POST(request: Request) {
  const limited = checkRateLimit(request, 'internal-messages', 60);
  if (limited) return limited;

  const session = await requireInternalMember();
  if (!session) return NextResponse.json({ error: 'No autorizado' }, { status: 403 });

  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: 'JSON inválido en el body' }, { status: 400 });

  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (!content) return new NextResponse('Falta content', { status: 400 });

  const room = await resolveRoom(session.tenant_id, body.roomId ?? null);
  if (!room) return new NextResponse('Sala no encontrada', { status: 404 });

  const { data: saved, error } = await supabaseAdmin
    .from('internal_messages')
    .insert({
      tenant_id:   session.tenant_id,
      room_id:     room.id,
      author_id:   session.sub,
      author_name: session.name,
      author_role: session.role,
      content,
    })
    .select('*')
    .single();

  if (error || !saved) return new NextResponse(error?.message ?? 'Error guardando mensaje', { status: 500 });

  return NextResponse.json(saved, { status: 201 });
}
