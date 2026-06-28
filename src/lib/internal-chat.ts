import { supabaseAdmin } from '@/lib/db';
import { getSessionAgent } from '@/lib/current-agent';
import type { SessionPayload } from '@/lib/session';

// ─────────────────────────────────────────────────────────────────────────────
// Chat interno del equipo (Etapa 1) — helpers compartidos.
//
// Aislamiento estricto por tenant_id. La membresía del chat interno es SOLO
// para los roles 'agent' y 'operator' de un tenant. El admin de plataforma NO
// participa: se excluye por ROL (no por tenant) y nunca hay una rama que le dé
// acceso ampliado a las salas de otros tenants.
// ─────────────────────────────────────────────────────────────────────────────

export type InternalRoom = {
  id: string;
  name: string;
  kind?: 'group' | 'dm';
  participant_a?: string | null;
  participant_b?: string | null;
};

// Campos que pedimos siempre: incluyen tipo/participantes para poder validar
// la pertenencia en salas de DM.
const ROOM_COLS = 'id, name, kind, participant_a, participant_b';

// Devuelve la sesión si es miembro del chat interno (agent/operator), o null.
// El admin de plataforma queda fuera por diseño.
export async function requireInternalMember(): Promise<SessionPayload | null> {
  const session = await getSessionAgent();
  if (!session) return null;
  if (session.role !== 'agent' && session.role !== 'operator') return null;
  return session;
}

// Get-or-create de la sala GRUPAL del tenant (una sola por tenant, kind='group').
// Idempotente: el índice único parcial absorbe la carrera entre dos creaciones
// simultáneas; ante conflicto se re-lee la fila existente.
export async function getOrCreateRoom(tenantId: string): Promise<InternalRoom | null> {
  // 1) Intentar leer la sala grupal existente.
  const { data: existing } = await supabaseAdmin
    .from('internal_rooms')
    .select(ROOM_COLS)
    .eq('tenant_id', tenantId)
    .eq('kind', 'group')
    .maybeSingle();
  if (existing) return existing as InternalRoom;

  // 2) No existe → crearla. Si otra request la creó en el ínterin, el insert
  //    choca con el índice único parcial: lo ignoramos y re-leemos.
  const { data: created, error } = await supabaseAdmin
    .from('internal_rooms')
    .insert({ tenant_id: tenantId, kind: 'group' })
    .select(ROOM_COLS)
    .single();

  if (created) return created as InternalRoom;

  if (error) {
    const { data: again } = await supabaseAdmin
      .from('internal_rooms')
      .select(ROOM_COLS)
      .eq('tenant_id', tenantId)
      .eq('kind', 'group')
      .maybeSingle();
    if (again) return again as InternalRoom;
  }
  return null;
}

// Get-or-create de la sala de DM 1 a 1 entre dos miembros del tenant. El par se
// ordena (uuid menor/mayor) para que sea único sin importar quién lo abre.
// Idempotente igual que getOrCreateRoom. No valida roles acá (lo hace el caller).
export async function getOrCreateDmRoom(
  tenantId: string,
  memberX: string,
  memberY: string,
): Promise<InternalRoom | null> {
  if (!memberX || !memberY || memberX === memberY) return null;
  const [a, b] = memberX < memberY ? [memberX, memberY] : [memberY, memberX];

  const { data: existing } = await supabaseAdmin
    .from('internal_rooms')
    .select(ROOM_COLS)
    .eq('tenant_id', tenantId)
    .eq('kind', 'dm')
    .eq('participant_a', a)
    .eq('participant_b', b)
    .maybeSingle();
  if (existing) return existing as InternalRoom;

  const { data: created, error } = await supabaseAdmin
    .from('internal_rooms')
    .insert({ tenant_id: tenantId, kind: 'dm', participant_a: a, participant_b: b })
    .select(ROOM_COLS)
    .single();
  if (created) return created as InternalRoom;

  if (error) {
    const { data: again } = await supabaseAdmin
      .from('internal_rooms')
      .select(ROOM_COLS)
      .eq('tenant_id', tenantId)
      .eq('kind', 'dm')
      .eq('participant_a', a)
      .eq('participant_b', b)
      .maybeSingle();
    if (again) return again as InternalRoom;
  }
  return null;
}

// ¿Esta sala es accesible para este agente? El grupo es de todos los miembros;
// un DM SOLO de sus dos participantes (corte de aislamiento entre operadores).
export function canAccessRoom(room: InternalRoom, agentId: string): boolean {
  if ((room.kind ?? 'group') !== 'dm') return true;
  return room.participant_a === agentId || room.participant_b === agentId;
}

// No-leídos de una sala para un miembro: mensajes de OTROS con created_at por
// encima de su last_read_at (todos si nunca leyó). Compartido por /unread y
// /members.
export async function countRoomUnread(tenantId: string, roomId: string, agentId: string): Promise<number> {
  const { data: readRow } = await supabaseAdmin
    .from('internal_room_reads')
    .select('last_read_at')
    .eq('room_id', roomId)
    .eq('agent_id', agentId)
    .maybeSingle();

  let query = supabaseAdmin
    .from('internal_messages')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('room_id', roomId)
    .neq('author_id', agentId);

  if (readRow?.last_read_at) query = query.gt('created_at', readRow.last_read_at);

  const { count, error } = await query;
  if (error) return 0;
  return count ?? 0;
}

// Postea un mensaje en la sala del tenant desde el SERVER (avisos de caja:
// sueldo, cargas, descargas, cierres). Best-effort: si falla, devuelve null y el
// caller NO debe abortar su operación principal por esto. Si se pasa imageUrl, el
// mensaje va como JSON {_type:'image', url, caption}; si no, como texto plano.
export async function postInternalSystemMessage(
  session: SessionPayload,
  text: string,
  imageUrl?: string | null,
): Promise<boolean> {
  try {
    const room = await getOrCreateRoom(session.tenant_id);
    if (!room) return false;
    const content = imageUrl
      ? JSON.stringify({ _type: 'image', url: imageUrl, caption: text })
      : text;
    const { error } = await supabaseAdmin.from('internal_messages').insert({
      tenant_id:   session.tenant_id,
      room_id:     room.id,
      author_id:   session.sub,
      author_name: session.name,
      author_role: session.role,
      content,
    });
    return !error;
  } catch {
    return false;
  }
}

// Resuelve el room_id pedido validando que pertenezca al tenant de la sesión.
// Si no se pasa roomId, devuelve (o crea) la sala GRUPAL del tenant. Si se pasa
// `agentId` y la sala es un DM, exige que el agente sea uno de los participantes
// (corte de aislamiento entre operadores). Devuelve null si no pasa los chequeos.
export async function resolveRoom(
  tenantId: string,
  roomId?: string | null,
  agentId?: string | null,
): Promise<InternalRoom | null> {
  if (!roomId) return getOrCreateRoom(tenantId);

  const { data } = await supabaseAdmin
    .from('internal_rooms')
    .select(ROOM_COLS)
    .eq('id', roomId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  const room = (data as InternalRoom) ?? null;
  if (!room) return null;
  if (agentId && !canAccessRoom(room, agentId)) return null;
  return room;
}
