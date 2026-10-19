/** READ-ONLY: auditoría de salud/performance. Solo SELECT/count/RPC de lectura. */
import { createClient } from '@supabase/supabase-js';
const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const sb = createClient(URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
console.log('Supabase URL host:', new URL_(URL).host);
function URL_(u){ return new globalThis.URL(u); }

const TABLES = ['messages','contacts','comprobantes','campaign_recipients','campaign_message_status',
  'internal_messages','internal_rooms','agents','tenants','whatsapp_numbers','whatsapp_templates',
  'campaigns','casino_sessions','push_subscriptions','activity_log','movimientos','quick_replies','casino_accounts'];

console.log('\n=== TAMAÑO DE TABLAS (count exact) ===');
const sizes = {};
for (const t of TABLES) {
  const t0 = Date.now();
  const { count, error } = await sb.from(t).select('*', { count: 'exact', head: true });
  const ms = Date.now() - t0;
  sizes[t] = count;
  console.log(`${t.padEnd(26)} ${error ? 'ERROR: '+error.message : String(count).padStart(9)+' filas'}   (${ms} ms)`);
}
export {};
