import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Cliente Supabase ÚNICO para el browser (Realtime). Evita abrir un websocket
// por componente: todos los canales comparten esta misma conexión.
// Devuelve null si faltan las env vars públicas.
let client: SupabaseClient | null = null;

export function getSupabaseBrowser(): SupabaseClient | null {
  if (client) return client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  client = createClient(url, key);
  return client;
}
