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

export type InternalRoom = { id: string; name: string };

// Devuelve la sesión si es miembro del chat interno (agent/operator), o null.
// El admin de plataforma queda fuera por diseño.
export async function requireInternalMember(): Promise<SessionPayload | null> {
  const session = await getSessionAgent();
  if (!session) return null;
  if (session.role !== 'agent' && session.role !== 'operator') return null;
  return session;
}

// Get-or-create de la sala del tenant (Etapa 1: una sola sala por tenant).
// Idempotente: el unique(tenant_id) absorbe la carrera entre dos creaciones
// simultáneas; ante conflicto se re-lee la fila existente.
export async function getOrCreateRoom(tenantId: string): Promise<InternalRoom | null> {
  // 1) Intentar leer la sala existente.
  const { data: existing } = await supabaseAdmin
    .from('internal_rooms')
    .select('id, name')
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (existing) return existing as InternalRoom;

  // 2) No existe → crearla. Si otra request la creó en el ínterin, el insert
  //    choca con unique(tenant_id): lo ignoramos y re-leemos.
  const { data: created, error } = await supabaseAdmin
    .from('internal_rooms')
    .insert({ tenant_id: tenantId })
    .select('id, name')
    .single();

  if (created) return created as InternalRoom;

  if (error) {
    const { data: again } = await supabaseAdmin
      .from('internal_rooms')
      .select('id, name')
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (again) return again as InternalRoom;
  }
  return null;
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
// Si no se pasa roomId, devuelve (o crea) la sala del tenant. Devuelve null si
// el roomId no es del tenant (corte de aislamiento).
export async function resolveRoom(
  tenantId: string,
  roomId?: string | null,
): Promise<InternalRoom | null> {
  if (!roomId) return getOrCreateRoom(tenantId);

  const { data } = await supabaseAdmin
    .from('internal_rooms')
    .select('id, name')
    .eq('id', roomId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  return (data as InternalRoom) ?? null;
}
