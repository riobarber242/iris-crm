/**
 * Prueba OFFLINE del PR A (retry-on-401): no toca el casino ni la red. Transpila
 * client.ts con el TypeScript que ya trae el repo, stubea global.fetch y verifica
 * el comportamiento del token cacheado.
 *
 * Cada caso importa una instancia FRESCA del módulo (el cache de tokens es estado
 * de módulo): sin eso los casos se contaminan entre sí y un test puede pasar por el
 * motivo equivocado.
 *
 *   node scripts/diag-401-retry-test.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import ts from 'typescript';

process.env.CASINO_PROXY_URL = 'https://proxy.test';
process.env.CASINO_PROXY_SECRET = 'secret';

const src = readFileSync('src/lib/casino/client.ts', 'utf8');   // sólo importa un TIPO: se borra al transpilar
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
mkdirSync('.tmp-test', { recursive: true });
writeFileSync('.tmp-test/client.mjs', js);

let instancia = 0;
const modulaFresco = () => import(`../.tmp-test/client.mjs?v=${++instancia}`);

const CREDS = {
  agentUsername: 'ag', agentId: 'aid', agentPassword: 'pw',
  skinId: 's', skinDomain: 'casino.test', tenantId: 't',
};

const jsonRes = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});

// plan = respuestas sucesivas de las llamadas de API (no de Authenticate, que
// siempre entrega token). Devuelve la traza de llamadas para poder afirmar sobre ella.
function stub(plan) {
  const traza = [];
  let i = 0;
  global.fetch = async (url) => {
    const esAuth = String(url).includes('TokenAuth/Authenticate');
    traza.push(esAuth ? 'AUTH' : 'API');
    if (esAuth) return jsonRes(201, { result: { accessToken: 'tok' + traza.length, expireInSeconds: 3600 } });
    const paso = plan[Math.min(i++, plan.length - 1)];
    return paso === 401 ? jsonRes(401, { error: {} }) : jsonRes(200, { result: 12345 });
  };
  return traza;
}

const casos = [];
const check = (nombre, ok, detalle) => {
  casos.push(ok);
  console.log(`${ok ? '✅' : '❌'} ${nombre}${detalle ? '  [' + detalle + ']' : ''}`);
};

// ── 1) Token nuevo: un Authenticate y una llamada ───────────────────────────
{
  const c = await modulaFresco();
  const t = stub([200]);
  const bal = await c.getAgentBalance(CREDS);
  check('token nuevo → AUTH + API', bal === 12345 && t.join(',') === 'AUTH,API', t.join(','));

  // ── 2) La 2ª llamada reusa el token: NO hay Authenticate ─────────────────
  const t2 = stub([200]);
  await c.getAgentBalance(CREDS);
  check('2ª llamada reusa el token cacheado (sin AUTH)', t2.join(',') === 'API', t2.join(','));

  // ── 3) 401 con token cacheado → invalida y reintenta UNA vez ─────────────
  const t3 = stub([401, 200]);
  const bal3 = await c.getAgentBalance(CREDS);
  check('401 con token cacheado → invalida y reintenta una vez',
    bal3 === 12345 && t3.join(',') === 'API,AUTH,API', t3.join(','));
}

// ── 4) 401 con token RECIÉN pedido → NO reintenta (no acerca un lockout) ────
{
  const c = await modulaFresco();          // cache vacío de verdad
  const t = stub([401, 200]);
  const bal = await c.getAgentBalance(CREDS);
  check('401 con token fresco → NO reintenta', bal === null && t.join(',') === 'AUTH,API', t.join(','));
}

// ── 5) 401 en el reintento → el token muerto NO queda cacheado ──────────────
{
  const c = await modulaFresco();
  stub([200]);
  await c.getAgentBalance(CREDS);           // deja un token en el cache
  const t = stub([401, 401]);
  await c.getAgentBalance(CREDS);           // 401 → invalida → reintenta → 401
  check('doble 401 → agota el reintento', t.join(',') === 'API,AUTH,API', t.join(','));

  const t5 = stub([200]);
  await c.getAgentBalance(CREDS);
  check('tras el doble 401 el cache quedó limpio (pide token nuevo)',
    t5.join(',') === 'AUTH,API', t5.join(','));
}

rmSync('.tmp-test', { recursive: true, force: true });
const fallaron = casos.filter((ok) => !ok).length;
console.log(`\n${casos.length - fallaron}/${casos.length} OK`);
process.exit(fallaron ? 1 : 0);
