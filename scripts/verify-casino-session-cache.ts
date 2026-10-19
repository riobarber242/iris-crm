// Verificación en vivo del cache persistente de token (tabla casino_sessions).
//
// Se corre DOS VECES en procesos separados: cada proceso es una "instancia fría"
// de Vercel, con el Map en memoria de client.ts vacío. Lo que se busca:
//   1ra corrida → no hay fila → Authenticate contra el casino → escribe la fila.
//   2da corrida → NO debe haber Authenticate: el token sale de la base.
//
// SECRET_ENC_KEY: la de producción está marcada Sensitive y Vercel no la entrega,
// así que acá se usa una clave de TEST fija. Es seguro: producción todavía corre el
// código viejo, que no lee ni escribe casino_sessions. La fila que deja esta prueba
// se borra con --limpiar.
//
// Uso:  npx tsx scripts/verify-casino-session-cache.ts [--limpiar]
import { readFileSync } from 'node:fs';

// OJO con el split: .env.local tiene finales de línea MEZCLADOS (CRLF y LF), y en JS
// el `.` no matchea `\r`, así que `(.*)$` contra una línea con CRLF no matchea nunca.
for (const linea of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = linea.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
  if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}
// Clave de test (32 bytes en base64). NO es la de producción.
process.env.SECRET_ENC_KEY = 'dGVzdC1rZXktc29sby1wYXJhLXZlcmlmaWNhcjEyMzQ=';

const TENANT = 'f56fdb7c-cf5c-45df-854f-cd040fdd3b95';
const LIMPIAR = process.argv.includes('--limpiar');

async function main() {
  const { getAgentBalance } = await import('../src/lib/casino/client');
  const { supabaseAdmin } = await import('../src/lib/db');

  // Creds armadas a mano: loadCasinoAccount descifraría agent_password_enc con la
  // clave de producción, que no tenemos. El password sale de CASINO_AGENT_PASSWORD.
  const { data: acc } = await supabaseAdmin.from('casino_accounts')
    .select('id, tenant_id, agent_username, agent_id, skin_id, skin_domain')
    .eq('tenant_id', TENANT).eq('is_default', true).eq('active', true).maybeSingle();
  if (!acc) { console.error('no hay fila en casino_accounts'); return; }

  const creds = {
    accountId: (acc as any).id,
    tenantId: (acc as any).tenant_id,
    agentUsername: (acc as any).agent_username,
    agentId: (acc as any).agent_id,
    skinId: (acc as any).skin_id,
    skinDomain: (acc as any).skin_domain,
    agentPassword: process.env.CASINO_AGENT_PASSWORD!,
  };
  console.log(`cuenta: agente=${creds.agentUsername} target=${creds.skinDomain} accountId=${creds.accountId}`);

  const fila = () => supabaseAdmin.from('casino_sessions')
    .select('account_id, tenant_id, access_token_enc, expires_at, obtained_at, last_401_at')
    .eq('account_id', creds.accountId).maybeSingle();

  if (LIMPIAR) {
    await supabaseAdmin.from('casino_sessions').delete().eq('account_id', creds.accountId);
    console.log('fila borrada.');
    return;
  }

  const antes = await fila();
  console.log('fila ANTES:', antes.data ? `hay (expires_at=${(antes.data as any).expires_at})` : '(no hay)');

  const t0 = Date.now();
  const saldo = await getAgentBalance(creds as any);
  console.log(`getAgentBalance → ${saldo}  (${Date.now() - t0}ms)`);

  const desp = await fila();
  if (!desp.data) { console.log('fila DESPUES: (no hay) ← el cache NO guardó'); return; }
  const d: any = desp.data;
  const ttlMin = Math.round((new Date(d.expires_at).getTime() - Date.now()) / 60000);
  console.log('fila DESPUES:');
  console.log(`   tenant_id      = ${d.tenant_id}`);
  console.log(`   cifrado?       = ${String(d.access_token_enc).startsWith('gcm$') ? 'SI (gcm$…)' : 'NO → ' + String(d.access_token_enc).slice(0, 12)}`);
  console.log(`   largo enc      = ${String(d.access_token_enc).length}`);
  console.log(`   expires_at     = ${d.expires_at}  (vence en ~${ttlMin} min)`);
  console.log(`   obtained_at    = ${d.obtained_at}`);
  console.log(`   last_401_at    = ${d.last_401_at ?? 'null'}`);
}
main().catch((e) => console.error('ERROR:', e?.message ?? e));
