// Emite eventos de Realtime Broadcast desde el SERVER vía el endpoint HTTP de
// Supabase (sin websocket: ideal para funciones serverless de Vercel).
// Best-effort: NUNCA lanza. Si falla, el consumidor sigue andando por el polling
// de respaldo que ya existe en el front.
//
// Fase 2 (piloto chat interno): recupera la inmediatez que se perdió cuando RLS
// cortó postgres_changes para la anon key. El navegador escucha un canal (topic)
// por sala; el server emite la señal 'new_message' al entrar un mensaje. La señal
// NO lleva contenido: el cliente re-fetchea por la API autenticada, así no
// exponemos ningún dato del chat interno a la anon key.

const SUPABASE_URL     = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function broadcast(topic: string, event: string, payload: Record<string, unknown>): Promise<void> {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return;
  try {
    await fetch(`${SUPABASE_URL}/realtime/v1/api/broadcast`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey:         SERVICE_ROLE_KEY,
        Authorization:  `Bearer ${SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({ messages: [{ topic, event, payload }] }),
    });
  } catch (err) {
    console.warn('[realtime-broadcast] no se pudo emitir:', (err as Error)?.message ?? err);
  }
}

// Topic del chat interno por sala. DEBE coincidir con el nombre del canal del
// cliente (InternalChatClient usa `client.channel('internal:room:${roomId}')`).
export function internalRoomTopic(roomId: string): string {
  return `internal:room:${roomId}`;
}

// Señal 'new_message' para una sala del chat interno. Sin contenido: el cliente
// que la reciba re-fetchea sus mensajes por la API autenticada. Best-effort.
export async function broadcastNewInternalMessage(roomId: string): Promise<void> {
  if (!roomId) return;
  await broadcast(internalRoomTopic(roomId), 'new_message', { room_id: roomId });
}
