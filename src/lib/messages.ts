import { supabaseAdmin } from '@/lib/db';
import { broadcastNewMessage } from '@/lib/realtime-broadcast';

// Campos de un mensaje del chat de clientes. Flexible a propósito: los distintos
// orígenes (entrantes del webhook, respuestas del bot, envíos del operador,
// campañas, avisos de caja, plantillas) usan columnas distintas (role, agent_*,
// status, whatsapp_message_id, type, media JSON…). En la práctica todos traen
// contact_id y tenant_id, que son los que necesita la señal de broadcast; el
// tipo se deja abierto para aceptar los `Record<string, any>` que arman algunos
// callers, y el broadcast hace su propio guard si faltara alguno.
export type MessageFields = Record<string, any>;

// ÚNICO punto de escritura del chat de clientes (Fase 2): inserta el mensaje y, si
// salió bien, emite la señal de Realtime Broadcast del tenant. TODOS los callers
// (rutas de mensajes/imagen/audio/plantilla, campañas, avisos de caja de
// comprobantes y el webhook de Meta) pasan por acá, así el broadcast queda
// garantizado sin duplicar lógica. El broadcast es best-effort: no bloquea ni hace
// fallar el insert (el front tiene polling + postgres_changes de respaldo).
// Devuelve la misma forma { data, error } que el insert directo (error crudo de
// Postgrest, con .message), para no cambiar el manejo de errores de los callers.
export async function insertMessage(
  fields: MessageFields,
): Promise<{ data: any | null; error: any }> {
  const { data, error } = await supabaseAdmin
    .from('messages')
    .insert(fields)
    .select('*')
    .single();

  if (!error && data) {
    // Señal sin contenido. No la await-eamos como crítica: si falla, el mensaje ya
    // está guardado y el polling / postgres_changes lo traen igual.
    await broadcastNewMessage(fields.tenant_id ?? '', fields.contact_id).catch(() => {});
  }
  return { data, error };
}
