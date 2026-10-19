/**
 * Chequeo READ-ONLY de la integración del casino (proxy Cloudflare → API del casino)
 * de un tenant. Sirve para confirmar de una si "no toma el casino" es real, sin
 * depositar plata: hace un Authenticate + GetAgentBalance en vivo y revisa la salud
 * de las cargas recientes en la base.
 *
 * Uso:  node --env-file=.env.local scripts/check-casino-health.mjs [tenant_id]
 *   · sin arg → Casino 17Star (default).
 *   · NO deposita, NO crea jugadores, NO toca plata. Solo lee.
 *
 * Password del agente:
 *   · si está SECRET_ENC_KEY → descifra el de casino_accounts (el REAL de prod).
 *   · si no → usa CASINO_AGENT_PASSWORD de env (fallback para correr local).
 *
 * El allowlist del Worker es la frontera real: si el skin_domain quedó fuera, el
 * Authenticate devuelve 403 "Forbidden casino target" y el script lo marca.
 */
import { createClient } from '@supabase/supabase-js';
import { createDecipheriv } from 'crypto';

const TENANT_DEFAULT = 'f56fdb7c-cf5c-45df-854f-cd040fdd3b95'; // Casino 17Star
const PROXY_URL      = process.env.CASINO_PROXY_URL;
const PROXY_SECRET   = process.env.CASINO_PROXY_SECRET ?? '';
const SB_URL         = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY         = process.env.SUPABASE_SERVICE_ROLE_KEY;
// Hosts que acepta el Worker (mantener en sync con ALLOWED_TARGETS de casino-proxy-worker.js).
const WORKER_ALLOWLIST = new Set(['admin.celuapuestas.fans', 'admin.celuapuestas.bond']);

if (!SB_URL || !SB_KEY) { console.error('Faltan credenciales de Supabase (--env-file=.env.local)'); process.exit(1); }
if (!PROXY_URL)         { console.error('Falta CASINO_PROXY_URL (--env-file=.env.local)'); process.exit(1); }

const tenantId = process.argv[2] || TENANT_DEFAULT;
const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });
const L = (s = '') => console.log(s);
const arDT = (iso) => new Date(new Date(iso).getTime() - 180 * 60000).toISOString().slice(0, 16).replace('T', ' ');

// AES-256-GCM: mismo formato "gcm$iv$tag$ct" que src/lib/secure-secret.ts.
function decryptSecret(stored) {
  const raw = process.env.SECRET_ENC_KEY;
  if (!raw) throw new Error('SECRET_ENC_KEY no está presente');
  const key = Buffer.from(raw, 'base64');
  const [scheme, ivB64, tagB64, ctB64] = String(stored ?? '').split('$');
  if (scheme !== 'gcm' || !ivB64 || !tagB64 || !ctB64) throw new Error('formato de secreto inválido');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  d.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ctB64, 'base64')), d.final()]).toString('utf8');
}

const headers = (skinDomain, extra = {}) => ({
  'Content-Type': 'application/json', 'X-Proxy-Secret': PROXY_SECRET, 'X-Casino-Target': skinDomain, ...extra,
});

async function main() {
  L(`Chequeo de salud del casino — ${arDT(new Date().toISOString())} AR — tenant ${tenantId}`);
  L(`proxy=${PROXY_URL}  ·  secret set=${!!PROXY_SECRET}\n`);

  // ── 1) Config de casino_accounts ─────────────────────────────────────────────
  L('━━━ 1. Configuración (casino_accounts) ━━━');
  const { data: acct, error: aErr } = await sb
    .from('casino_accounts')
    .select('agent_username, agent_id, skin_id, skin_domain, agent_password_enc, is_default, active')
    .eq('tenant_id', tenantId).eq('is_default', true).eq('active', true)
    .maybeSingle();
  if (aErr)  { L(`  ⛔ Error leyendo casino_accounts: ${aErr.message}`); process.exit(1); }
  if (!acct) { L('  ⛔ No hay conexión de casino activa/default para este tenant.'); process.exit(1); }

  const skinDomain = String(acct.skin_domain ?? '').trim();
  const domainOk = WORKER_ALLOWLIST.has(skinDomain.toLowerCase());
  L(`  agente=${acct.agent_username}  agent_id=${acct.agent_id}  skin_id=${acct.skin_id}`);
  L(`  skin_domain=${JSON.stringify(skinDomain)} ${domainOk ? '✅ en allowlist del Worker' : '⛔ NO está en el allowlist del Worker (el proxy va a devolver 403)'}`);
  L(`  password cifrado en DB: ${acct.agent_password_enc ? 'sí' : '⛔ NO'}`);

  // ── 2) Flag on/off ───────────────────────────────────────────────────────────
  const { data: flag } = await sb.from('settings').select('value').eq('key', 'casino_deposit_enabled').eq('tenant_id', tenantId).maybeSingle();
  L(`  casino_deposit_enabled = ${JSON.stringify(flag?.value)} ${flag?.value === 'true' ? '✅' : '⚠️ (los depósitos NO corren si no es "true")'}`);

  // Password a usar para la prueba en vivo.
  let password = null, pwSource = null;
  if (acct.agent_password_enc && process.env.SECRET_ENC_KEY) {
    try { password = decryptSecret(acct.agent_password_enc); pwSource = 'DB (descifrado)'; }
    catch (e) { L(`  ⚠ No se pudo descifrar el password de la DB (${e.message}); pruebo con env.`); }
  }
  if (!password && process.env.CASINO_AGENT_PASSWORD) { password = process.env.CASINO_AGENT_PASSWORD; pwSource = 'env CASINO_AGENT_PASSWORD'; }

  // ── 3) Prueba en vivo del proxy + casino (read-only) ─────────────────────────
  L('\n━━━ 2. Prueba en vivo (Authenticate + GetAgentBalance, sin depósito) ━━━');
  let liveOk = false, balance = null;
  if (!password) {
    L('  ⚠ Sin password disponible (ni SECRET_ENC_KEY para descifrar, ni CASINO_AGENT_PASSWORD). Salteo la prueba en vivo.');
  } else {
    L(`  (password: ${pwSource})`);
    let token = null;
    try {
      const r = await fetch(`${PROXY_URL}/api/TokenAuth/Authenticate`, {
        method: 'POST', headers: headers(skinDomain),
        body: JSON.stringify({ userNameOrEmailAddress: acct.agent_username, password, skinDomain }),
      });
      const body = await r.text();
      L(`  [Authenticate] HTTP ${r.status}`);
      if (r.status === 403 && /forbidden casino target/i.test(body)) L('    ⛔ Worker 403: skin_domain fuera del allowlist.');
      else if (r.status === 401 && /unauthorized/i.test(body))       L('    ⛔ Worker 401: X-Proxy-Secret inválido.');
      else {
        let j = null; try { j = JSON.parse(body); } catch { L('    ⚠ Respuesta no-JSON (¿HTML/bloqueo del casino?): ' + body.slice(0, 150)); }
        token = j?.result?.accessToken ?? null;
        if (token) L('    ✅ Login OK (accessToken recibido).');
        else L(`    ⛔ Login rechazado (sin accessToken)${j?.error ? ' — ' + JSON.stringify(j.error).slice(0, 150) : ''}`);
      }
    } catch (e) { L(`  ⛔ Authenticate excepción: ${e.message}`); }

    if (token) {
      try {
        const params = new URLSearchParams({ agentId: String(acct.agent_id), username: acct.agent_username });
        const r = await fetch(`${PROXY_URL}/api/services/app/Agent/GetAgentBalance?${params}`, { headers: headers(skinDomain, { Authorization: `Bearer ${token}` }) });
        const body = await r.text();
        L(`  [GetAgentBalance] HTTP ${r.status}`);
        let j = null; try { j = JSON.parse(body); } catch {}
        const bal = Number(j?.result);
        if (Number.isFinite(bal)) { balance = bal; liveOk = true; L(`    ✅ Saldo del agente: ${bal.toLocaleString('es-AR')}`); }
        else L(`    ⛔ Sin saldo numérico (agentId no cuelga de este login?): ${body.slice(0, 150)}`);
      } catch (e) { L(`  ⛔ GetAgentBalance excepción: ${e.message}`); }
    }
  }

  // ── 4) Salud de las cargas recientes (últimas 48h) ───────────────────────────
  L('\n━━━ 3. Cargas recientes (últimas 48h) ━━━');
  const since = new Date(Date.now() - 48 * 3600000).toISOString();
  const { data: rows } = await sb.from('comprobantes')
    .select('estado, casino_deposited_at, created_at, monto')
    .eq('tenant_id', tenantId).neq('tipo', 'pago').gte('created_at', since);
  const verif   = (rows ?? []).filter((c) => c.estado === 'verificado');
  const sinDep  = verif.filter((c) => !c.casino_deposited_at);
  const pend    = (rows ?? []).filter((c) => c.estado === 'pendiente');
  const deps    = (rows ?? []).filter((c) => c.casino_deposited_at).map((c) => c.casino_deposited_at).sort();
  L(`  cargas: ${rows?.length ?? 0}  ·  verificadas: ${verif.length}  ·  acreditadas al casino: ${deps.length}`);
  L(`  ⚠ verificadas SIN acreditar al casino: ${sinDep.length}${sinDep.length ? '  ← SÍNTOMA de "no toma el casino"' : '  ✅'}`);
  L(`  cargas pendientes (posible depósito que falló y no verificó): ${pend.length}`);
  L(`  último depósito exitoso: ${deps.length ? arDT(deps[deps.length - 1]) + ' AR' : 'ninguno en 48h'}`);

  // ── Veredicto ────────────────────────────────────────────────────────────────
  L('\n════════════════ VEREDICTO ════════════════');
  if (!domainOk) {
    L('⛔ skin_domain fuera del allowlist del Worker → el proxy rechaza todo. Corregí el skin_domain o el allowlist del Worker.');
  } else if (liveOk && sinDep.length === 0) {
    L(`✔ SANO de punta a punta. Proxy+casino responden, login OK, saldo=${balance?.toLocaleString('es-AR')}, y todas las cargas verificadas de 48h se acreditaron.`);
  } else if (liveOk && sinDep.length > 0) {
    L(`⚠ La conexión responde (saldo=${balance?.toLocaleString('es-AR')}) PERO hay ${sinDep.length} cargas verificadas sin acreditar → revisar casos puntuales (¿player no encontrado?).`);
  } else if (password) {
    L('⛔ La prueba en vivo FALLÓ (ver arriba). La conexión al casino NO está sana.');
  } else {
    L('ℹ Sin password para la prueba en vivo; el veredicto va solo por la salud de las cargas en DB.');
  }
  L('\n(read-only — no se depositó ni se creó nada)');
}

main().catch((e) => { console.error('EX', e); process.exit(1); });
