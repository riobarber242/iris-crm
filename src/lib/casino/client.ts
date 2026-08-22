// src/lib/casino/client.ts
// Todas las llamadas al casino pasan por un Cloudflare Worker proxy (casino-proxy)
// que agrega Origin/Referer y desbloquea el acceso. El proxy se autentica con el
// header X-Proxy-Secret.
//
// Etapa 2, PR 2: el client ya NO conoce ninguna credencial de casino. Cada función
// recibe `creds: CasinoCreds` (usuario/id/password/skin del AGENTE de ESE tenant),
// resueltas por el route con resolveCasinoCreds(). Solo el proxy (URL + secret)
// sigue siendo global: es infraestructura compartida, no una credencial de casino.

import type { CasinoCreds } from './account';
import { deleteSession, readSession, writeSession } from './session-store';

const PROXY_URL = process.env.CASINO_PROXY_URL!;
const PROXY_SECRET = process.env.CASINO_PROXY_SECRET ?? '';

// Cache en memoria del access token (por instancia/lambda), keyed por
// skinDomain|agentUsername: cada agente/casino tiene su propio token. Se renueva
// vía TokenAuth/Authenticate cuando vence, con un margen de 60s.
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

const tokenKey = (creds: CasinoCreds) => `${creds.skinDomain}|${creds.agentUsername}`;

// Margen contra el vencimiento. Eran 60s cuando el cache vivia solo en memoria de
// una instancia; ahora el mismo token cruza instancias y relojes distintos, asi que
// conviene mas aire. Con el TTL real del casino (3600s) esto cuesta un login extra
// cada 12 horas: nada.
const TOKEN_MARGIN_MS = 5 * 60_000;

// Tira el token cacheado de estas credenciales. Hace falta porque un token puede
// morir ANTES de su expiración (el casino reinicia, revoca la sesión, rota su
// clave de firma) y hasta ahora nadie borraba el cache nunca: el tenant quedaba
// roto hasta que venciera el TTL. Con el cache persistente del PR B eso sería peor
// todavía, así que la invalidación va primero.
// Devuelve si REALMENTE había un token cacheado: quien acaba de pedir uno fresco y
// aun así comió un 401 no gana nada reintentando.
async function invalidateCasinoToken(creds: CasinoCreds, rechazado = false): Promise<void> {
  tokenCache.delete(tokenKey(creds));
  await deleteSession(creds, rechazado);
}

// Header común que autentica cada request contra el Worker proxy. X-Casino-Target
// le dice al Worker a qué casino reenviar (el skin_domain del tenant); el Worker lo
// valida contra su allowlist. Etapa 2, PR 3: multi-tenant en el proxy.
function proxyHeaders(skinDomain: string, extra?: Record<string, string>) {
  return {
    'Content-Type': 'application/json',
    'X-Proxy-Secret': PROXY_SECRET,
    'X-Casino-Target': skinDomain,
    ...extra,
  };
}

// Corte duro de 8s: si el proxy/casino no responde, abortamos y lanzamos un error
// claro en vez de colgar la función serverless hasta el límite de Vercel.
const CASINO_TIMEOUT_MS = 8000;
// AddPlayer suele tardar más que un GET; le damos más margen para no abortar una
// creación que en realidad está por completar (evita usuarios duplicados).
const ADDPLAYER_TIMEOUT_MS = 15000;

async function casinoFetch(url: string, init: RequestInit, timeoutMs: number = CASINO_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err: any) {
    if (err?.name === 'AbortError') throw new Error('El casino no respondió a tiempo');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ── Reintento ante respuestas inservibles ─────────────────────────────────────
// El casino devuelve por rachas su propia SPA (HTML) con HTTP 200 en vez del JSON
// de la API: su ingress sirve el front-end cuando su backend de API no está.
// Verificado en los logs del 19/08/2026: el MISMO login alternaba 201+token y HTML
// con un minuto de diferencia. Dos reintentos cortos tapan esos hipos de decenas
// de segundos sin que se note del lado de IRIS.
//
// SOLO para operaciones idempotentes (Authenticate, GetAgentBalance,
// GetAgentWithChildren). DoDeposit y AddPlayer NO se reintentan NUNCA: acreditar
// dos veces o crear dos jugadores es peor que fallar.
//
// La escalera vieja ([500, 1500]) cubría ~2s: menos que la racha real de HTML, que
// dura decenas de segundos. El 20/08/2026 no entró UN solo depósito en 25h y cada
// intento moría con "body no es JSON tras 3 intento(s)".
const RETRY_DELAYS_MS = [1000, 3000, 8000];

// El saldo del agente es polling VISUAL del panel: si el casino está en una racha,
// que el chip tarde en actualizarse no le cuesta nada a nadie, y insistir 12s por
// cada poll sí. Se queda con la escalera corta de antes (~1,5s).
const BALANCE_RETRY_DELAYS_MS = [500, 1000];
const BALANCE_BUDGET_MS = 6_000;

// El techo de verdad: la función serverless. Un depósito encadena DOS operaciones
// que reintentan (Authenticate + GetAgentWithChildren) y después DoDeposit, así que
// la escalera sola sumaría 12s de sleep POR operación y Vercel mataría el request a
// mitad — el operador vería un 504 genérico, peor que el error de hoy. Por eso el
// presupuesto es COMPARTIDO por todo el flujo y se reparte entre los reintentos:
// cada intento se recorta a lo que quede y la escalera corta cuando no entra otro.
const CREDIT_BUDGET_MS = 45_000;   // creditPlayer completo (route: maxDuration = 60)
// El resto de los routes de casino (balance, test-connection, alta) NO declaran
// maxDuration, así que corren con el default de Vercel (15s): el presupuesto queda
// por debajo a propósito para que la escalera nueva no se coma la función entera.
const DEFAULT_BUDGET_MS = 10_000;
// Piso estimado de un intento: si no entra esto además del sleep, no vale la pena.
const MIN_ATTEMPT_MS = 1_500;

const remainingMs = (deadlineAt: number) => Math.max(0, deadlineAt - Date.now());

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface CasinoJsonResult {
  res: Response | null;
  status: number;
  body: string;
  json: any | null;
  /** Llegó respuesta pero no es JSON usable (HTML de la SPA, texto suelto, vacío). */
  notJson: boolean;
  timedOut: boolean;
  attempts: number;
}

// Ante la duda SIEMPRE tratamos la falla como "el casino no pudo contestar", nunca
// como credencial mala. Un falso "contraseña incorrecta" hace que la gente la
// vuelva a tipear y termine pisando la buena: fue exactamente lo que pasó el
// 20/08/2026 (7 contraseñas distintas guardadas en 24 minutos mientras el casino
// devolvía HTML de forma intermitente).
const CRED_ERROR_RE = /invalid|incorrect|wrong|credential|credencial|password|contrase|user ?name|usuario|login/i;

// ¿El casino dijo explícitamente que la credencial está mal? ABP manda ese rechazo
// con 401 y también con 500, así que el status solo no alcanza.
function isCredRejection(r: CasinoJsonResult): boolean {
  if (r.notJson || !r.json) return false;
  const msg = [r.json?.error?.message, r.json?.error?.details].filter(Boolean).join(' ');
  return !!msg && CRED_ERROR_RE.test(msg);
}

// 401/403 y los rechazos explícitos de credenciales NO se reintentan: además de
// inútil, insistir con una credencial rechazada es lo que dispara lockouts del
// lado del casino.
function isTransient(r: CasinoJsonResult): boolean {
  if (r.status === 401 || r.status === 403) return false;
  if (isCredRejection(r)) return false;
  return r.notJson || r.status === 429 || r.status >= 500;
}

// ── Diagnóstico de origen (21/08/2026) ───────────────────────────────────────
// Lee los headers que agrega el Worker (casino-proxy-worker.js) para contestar de
// una la pregunta que quedó abierta: el HTML de la SPA, ¿depende del MOMENTO o de
// DÓNDE sale el request? Medición del 21/08 14:28-14:37: prod (Vercel) sacó 15/15
// HTML mientras la notebook de Gonza sacaba 18/18 JSON+token por el MISMO Worker y
// con las MISMAS credenciales — o sea que no parece una racha del casino.
//
//   colo/país     → colo de Cloudflare desde el que salió el request al casino. Un
//                   Worker corre cerca de QUIEN LO LLAMA: Vercel (us-east) y una
//                   notebook argentina salen por colos distintos.
//   cf-ray/server → huella de la respuesta DEL CASINO. Si el HTML trae cf-ray y
//                   server: cloudflare, lo sirvió un WAF y no el backend del casino.
//
// Mientras siga arriba el Worker viejo devuelve un aviso en vez de datos: el backend
// se puede deployar antes sin romper nada, solo que todavía no hay dato.
function proxyDiag(res: Response | null): string {
  if (!res) return 'sin respuesta';
  const h = (n: string) => res.headers.get(n);
  const colo = h('x-proxy-colo');
  if (!colo) return '(sin headers del proxy — ¿Worker sin el diagnóstico?)';
  return (
    `colo=${colo} país=${h('x-proxy-country') ?? '-'} ` +
    `casino[cf-ray=${h('x-casino-cf-ray') ?? '-'} server=${h('x-casino-server') ?? '-'} ` +
    `cf-cache=${h('x-casino-cf-cache') ?? '-'} ct=${h('content-type') ?? '-'}]`
  );
}

// Wrapper de casinoFetch que además parsea el JSON y reintenta las fallas
// transitorias. `init.body` es siempre un string en este módulo, así que se puede
// reenviar tal cual en cada intento.
async function casinoFetchJson(
  url: string,
  init: RequestInit,
  opts: { label: string; timeoutMs?: number; deadlineAt?: number; retryDelaysMs?: number[] },
): Promise<CasinoJsonResult> {
  // Sin deadline explícito cada llamada igual lleva su propio techo: así ningún
  // camino puede desbordar por la escalera nueva.
  const deadlineAt = opts.deadlineAt ?? Date.now() + DEFAULT_BUDGET_MS;
  const delays = opts.retryDelaysMs ?? RETRY_DELAYS_MS;

  let last: CasinoJsonResult = {
    res: null, status: 0, body: '', json: null, notJson: false, timedOut: false, attempts: 0,
  };

  for (let attempt = 1; attempt <= delays.length + 1; attempt++) {
    const budget = remainingMs(deadlineAt);
    if (budget <= 0) {
      if (attempt === 1) {
        return {
          res: null, status: 0, json: null, notJson: false, timedOut: true, attempts: 0,
          body: 'presupuesto de tiempo agotado antes de llamar al casino',
        };
      }
      break;
    }

    try {
      // El intento nunca puede durar más de lo que queda del presupuesto.
      const res = await casinoFetch(url, init, Math.min(opts.timeoutMs ?? CASINO_TIMEOUT_MS, budget));
      const body = await res.text().catch(() => '');
      let json: any = null;
      try { json = JSON.parse(body); } catch { /* no-JSON → notJson */ }
      last = { res, status: res.status, body, json, notJson: json === null, timedOut: false, attempts: attempt };
    } catch (err: any) {
      const timedOut = err?.message === 'El casino no respondió a tiempo';
      last = {
        res: null, status: 0, body: err?.message ?? 'error de red', json: null,
        notJson: false, timedOut, attempts: attempt,
      };
      // Un timeout ya se comió CASINO_TIMEOUT_MS enteros: reintentar arriesga que
      // Vercel mate la función. Se devuelve tal cual.
      if (timedOut) return last;
    }

    if (!isTransient(last)) return last;
    const delay = delays[attempt - 1];
    if (delay === undefined) break;
    // Si el sleep más un intento mínimo no entran en lo que queda, cortamos acá:
    // mejor devolver el error real que morir a mitad por timeout de la función.
    if (remainingMs(deadlineAt) < delay + MIN_ATTEMPT_MS) {
      console.warn(
        `[Casino] ${opts.label}: sin presupuesto para el reintento ${attempt} ` +
        `(quedan ${remainingMs(deadlineAt)}ms, hacen falta ${delay + MIN_ATTEMPT_MS}ms) — corto acá`,
      );
      break;
    }
    console.warn(
      `[Casino] ${opts.label}: respuesta inservible (http=${last.status}${last.notJson ? ', body no-JSON' : ''})` +
      ` — reintento ${attempt}/${delays.length} en ${delay}ms — ${proxyDiag(last.res)}`,
    );
    await sleep(delay);
  }
  // El desenlace que estamos investigando: se agotaron los reintentos (o el
  // presupuesto) y el casino nunca mandó JSON. Acá queda el rastro del origen.
  if (last.notJson) {
    console.warn(`[Casino] ${opts.label}: NO-JSON definitivo tras ${last.attempts} intento(s) — ${proxyDiag(last.res)}`);
  }
  return last;
}

// De dónde salió el token. Importa para decidir si un 401 merece reintento: si el
// token se acaba de pedir, insistir no arregla nada y sólo acerca un lockout.
export type TokenSource = 'memoria' | 'base' | 'nuevo';

// Devuelve un access token válido del casino para ESTAS credenciales, buscándolo en
// tres capas:
//
//   1. memoria  — Map de módulo, vive lo que vive la instancia serverless.
//   2. base     — tabla casino_sessions, compartida por TODAS las instancias.
//   3. nuevo    — Authenticate contra el casino.
//
// La capa 2 es la que cambia el orden de magnitud: sin ella cada instancia nueva
// arrancaba con el cache vacío y pedía token, y así llegamos a ~94 Authenticate por
// hora contra un token que dura 3600s (medición del 21/08/2026 en prod).
//
// NO hay lock entre instancias: dos requests concurrentes con las tres capas frías
// pueden pedir dos tokens. Es aceptable — el casino acepta varios tokens vivos a la
// vez, y un lock distribuido agrega un modo de falla peor que el que evita.
async function resolveCasinoToken(
  creds: CasinoCreds,
  deadlineAt?: number,
  retryDelaysMs?: number[],
): Promise<{ token: string | null; source: TokenSource }> {
  const now = Date.now();
  const cacheKey = tokenKey(creds);

  const cached = tokenCache.get(cacheKey);
  if (cached && now < cached.expiresAt) return { token: cached.token, source: 'memoria' };

  const guardado = await readSession(creds);
  if (guardado) {
    tokenCache.set(cacheKey, guardado);
    return { token: guardado.token, source: 'base' };
  }

  if (!creds.agentPassword) return { token: null, source: 'nuevo' };

  try {
    const r = await casinoFetchJson(`${PROXY_URL}/api/TokenAuth/Authenticate`, {
      method: 'POST',
      headers: proxyHeaders(creds.skinDomain),
      body: JSON.stringify({
        userNameOrEmailAddress: creds.agentUsername,
        password: creds.agentPassword,
        skinDomain: creds.skinDomain,
      }),
    }, { label: 'Authenticate', deadlineAt, retryDelaysMs });

    // Sin el body: la respuesta de Authenticate trae el encryptedAccessToken entero
    // y quedaba escrito en claro en los logs de Vercel (visto el 22/08/2026). El
    // status y los intentos alcanzan para el diagnóstico; si el body hace falta,
    // los caminos de error ya lo loguean recortado (logTestFailure, body(300)).
    console.log(`[Casino] Authenticate http=${r.status} intentos=${r.attempts}`);

    if (r.timedOut) {
      console.error('[Casino] Authenticate: el casino no respondió a tiempo');
      return { token: null, source: 'nuevo' };
    }
    if (r.notJson) {
      console.error(`[Casino] Authenticate: body no es JSON (¿HTML?) tras ${r.attempts} intento(s)`);
      return { token: null, source: 'nuevo' };
    }
    if (r.status >= 400) return { token: null, source: 'nuevo' };

    const data = r.json;
    const token: string | null = data?.result?.accessToken ?? null;
    const expireInSeconds = Number(data?.result?.expireInSeconds ?? 0);
    if (!token) {
      console.error('[Casino] Authenticate no devolvió accessToken');
      return { token: null, source: 'nuevo' };
    }

    const expiresAt = vencimientoDelToken(token, expireInSeconds, now);
    tokenCache.set(cacheKey, { token, expiresAt });
    // Guardar en base es best-effort: si la tabla no está o la base falla, es un
    // no-op y seguimos con el de memoria (ver session-store.ts).
    await writeSession(creds, { token, expiresAt });
    return { token, source: 'nuevo' };
  } catch (err: any) {
    console.error('[Casino] Authenticate error:', err?.message ?? err);
    return { token: null, source: 'nuevo' };
  }
}

// Cuándo dejar de usar este token: el MENOR entre lo que declara el casino
// (expireInSeconds) y el claim exp del propio JWT, menos el margen.
//
// Los dos no coinciden ni de lejos: el 21/08/2026 el casino devolvía
// expireInSeconds=3600 con un JWT cuyo exp caía en enero de 2028 (~500 días). Se le
// cree al MÁS CORTO — el casino puede invalidar su sesión del lado del servidor
// cuando quiera, sin importar lo que diga la firma del token.
//
// El exp se lee decodificando el payload, sin verificar la firma: no somos nosotros
// los que validamos este token, sólo queremos saber hasta cuándo lo dan por bueno.
// Si el JWT no se puede leer, manda expireInSeconds.
function vencimientoDelToken(token: string, expireInSeconds: number, now: number): number {
  const porDeclaracion = now + Math.max(expireInSeconds, 0) * 1000;

  let porJwt = Infinity;
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64').toString('utf8'));
    if (typeof payload?.exp === 'number') porJwt = payload.exp * 1000;
  } catch { /* JWT ilegible → manda expireInSeconds */ }

  // El margen puede dejar el vencimiento en el pasado si el token venía muy corto:
  // en ese caso nace vencido y se pide uno nuevo, que es lo correcto.
  return Math.min(porDeclaracion, porJwt) - TOKEN_MARGIN_MS;
}

// Compatibilidad para los callers que sólo quieren el token.
async function getCasinoToken(
  creds: CasinoCreds,
  deadlineAt?: number,
  retryDelaysMs?: number[],
): Promise<string | null> {
  return (await resolveCasinoToken(creds, deadlineAt, retryDelaysMs)).token;
}

async function casinoHeaders(creds: CasinoCreds, deadlineAt?: number, retryDelaysMs?: number[]) {
  const token = await getCasinoToken(creds, deadlineAt, retryDelaysMs);
  return proxyHeaders(creds.skinDomain, { 'Authorization': `Bearer ${token}` });
}

// ── Reintento ante 401 (token muerto) ────────────────────────────────────────
// Un 401 con un token que salió del cache significa que ese token ya no sirve. Se
// invalida y se reintenta UNA sola vez con uno nuevo.
//
// SOLO para operaciones idempotentes (GetAgentBalance, GetAgentWithChildren).
// DoDeposit y AddPlayer NO pasan por acá: ante un 401 invalidan el token para que
// la próxima salga limpia, pero no se reintentan solas — mismo criterio que ya rige
// para los reintentos por HTML (acreditar dos veces es peor que fallar).
//
// Si el token NO venía del cache, no se reintenta: recién se pidió, así que el 401
// es por credencial o por bloqueo, y volver a pegar solo acerca un lockout.
async function withFreshTokenOnce(
  creds: CasinoCreds,
  label: string,
  call: (headers: Record<string, string>) => Promise<CasinoJsonResult>,
  opts: { deadlineAt?: number; retryDelaysMs?: number[]; teniaTokenCacheado?: boolean } = {},
): Promise<CasinoJsonResult> {
  // getPlayerTargetId resuelve el token por su cuenta antes de llamar acá, así que
  // para cuando llegamos el cache YA está poblado y el chequeo de abajo daría un
  // falso positivo. Ese caller pasa el dato de antes.
  const usoCache = opts.teniaTokenCacheado ?? tokenCache.has(tokenKey(creds));
  const first = await call(await casinoHeaders(creds, opts.deadlineAt, opts.retryDelaysMs));
  if (first.status !== 401 || !usoCache) return first;

  if (!invalidateCasinoToken(creds)) return first;
  console.warn(`[Casino] ${label}: 401 con el token cacheado — lo tiro y reintento con uno nuevo`);
  const second = await call(await casinoHeaders(creds, opts.deadlineAt, opts.retryDelaysMs));

  // Si el token RECIÉN pedido también come 401, no lo dejamos cacheado: nació muerto
  // (credencial revocada, bloqueo del casino) y guardarlo haría que la próxima llamada
  // arranque con un token que ya sabemos rechazado — y gaste otro par de requests en
  // redescubrirlo. Lo encontró el test offline scripts/diag-401-retry-test.mjs.
  if (second.status === 401) invalidateCasinoToken(creds);
  return second;
}

// Saldo de fichas del agente del casino del tenant. Baja al verificar cargas
// (deposita a un jugador) y sube al verificar pagos. Endpoint:
//   GET /api/services/app/Agent/GetAgentBalance?agentId=...&username=...
// Respuesta: { result: <number>, success: true }. Devuelve null si falla.
export async function getAgentBalance(creds: CasinoCreds): Promise<number | null> {
  const params = new URLSearchParams({ agentId: creds.agentId, username: creds.agentUsername });
  const url = `${PROXY_URL}/api/services/app/Agent/GetAgentBalance?${params}`;

  // Escalera corta y presupuesto propio: el chip del saldo falla rápido en vez de
  // colgar el poll. El Authenticate de esta llamada usa la misma escalera corta.
  const deadlineAt = Date.now() + BALANCE_BUDGET_MS;

  try {
    const r = await withFreshTokenOnce(
      creds,
      'GetAgentBalance',
      (headers) => casinoFetchJson(
        url, { method: 'GET', headers },
        { label: 'GetAgentBalance', deadlineAt, retryDelaysMs: BALANCE_RETRY_DELAYS_MS },
      ),
      { deadlineAt, retryDelaysMs: BALANCE_RETRY_DELAYS_MS },
    );
    if (r.timedOut) {
      console.error('[Casino] GetAgentBalance: el casino no respondió a tiempo');
      return null;
    }
    if (r.notJson) {
      console.error(`[Casino] GetAgentBalance: body no es JSON (¿HTML/bloqueo?) tras ${r.attempts} intento(s) — primeros 200:`, r.body.slice(0, 200));
      return null;
    }
    if (r.status >= 400) {
      console.error(`[Casino] GetAgentBalance HTTP ${r.status}`);
      return null;
    }
    const balance = Number(r.json?.result);
    return Number.isFinite(balance) ? balance : null;
  } catch (err: any) {
    console.error('[Casino] GetAgentBalance error:', err?.message ?? err);
    return null;
  }
}

// Resultado del lookup del jugador. Antes era `string | null` y ese null colapsaba
// CUATRO desenlaces distintos (timeout, HTML de la SPA, HTTP >=400 y jugador
// realmente ausente) en un único mensaje "Player no encontrado", que es mentira en
// tres de los cuatro casos. El 20/08/2026 eso nos mandó a investigar una migración
// de dominio que no tenía nada que ver: el casino estaba devolviendo su SPA.
// Mismo criterio que ya se aplica a las credenciales (isCredRejection/isTransient):
// ante la duda, la culpa es del casino, nunca del dato del usuario.
export type PlayerLookup =
  | { ok: true;  targetId: string }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'casino_unavailable'; detail: string };

export async function getPlayerTargetId(
  creds: CasinoCreds,
  username: string,
  deadlineAt?: number,
): Promise<PlayerLookup> {
  // El token va primero y por separado: si el Authenticate ya vino en HTML, sabemos
  // que el casino está caído y no gastamos presupuesto en un lookup condenado (antes
  // se mandaba igual con "Bearer null" y el 401 resultante se leía como otra falla).
  const teniaTokenCacheado = tokenCache.has(tokenKey(creds));
  const token = await getCasinoToken(creds, deadlineAt);
  if (!token) {
    return { ok: false, reason: 'casino_unavailable', detail: 'no se pudo autenticar contra el casino' };
  }

  const params = new URLSearchParams({
    parentId: '-1',
    username: creds.agentUsername,
    userId: 'NaN',
    userType: '2',
    searchText: username,
    onlyHidden: 'false',
    offset: '0',
    rowQty: '20',
    searchInAllTree: 'true',
  });

  const url = `${PROXY_URL}/api/services/app/Agent/GetAgentWithChildren?${params}`;

  // Logueamos el body RAW: cuando el casino sirve su SPA en HTML con status 200
  // (ver casinoFetchJson), esto muestra exactamente qué llegó. La búsqueda del
  // player es idempotente, así que se reintenta.
  const r = await withFreshTokenOnce(
    creds,
    'GetAgentWithChildren',
    (headers) => casinoFetchJson(url, { method: 'GET', headers }, { label: 'GetAgentWithChildren', deadlineAt }),
    { deadlineAt, teniaTokenCacheado },
  );
  console.log(`[Casino] GetAgentWithChildren raw body (200 chars, intentos=${r.attempts}):`, r.body.slice(0, 200));

  if (r.timedOut) {
    console.error('[Casino] GetAgentWithChildren: el casino no respondió a tiempo');
    return { ok: false, reason: 'casino_unavailable', detail: 'el casino no respondió a tiempo' };
  }
  if (r.notJson) {
    console.error(`[Casino] GetAgentWithChildren: body no es JSON (¿HTML/bloqueo?) tras ${r.attempts} intento(s) — primeros 500:`, r.body.slice(0, 500));
    return { ok: false, reason: 'casino_unavailable', detail: `body no es JSON tras ${r.attempts} intento(s) (¿HTML de la SPA?)` };
  }
  if (r.status >= 400) {
    console.error(`[Casino] GetAgentWithChildren HTTP ${r.status}`);
    return { ok: false, reason: 'casino_unavailable', detail: `HTTP ${r.status}` };
  }

  const data = r.json;
  console.log('[Casino] GetAgentWithChildren shape:', JSON.stringify(data, null, 2).substring(0, 3000));

  let items: any[] = [];
  if (Array.isArray(data)) items = data;
  else if (Array.isArray(data?.result)) items = data.result;
  else if (Array.isArray(data?.result?.items)) items = data.result.items;
  else if (Array.isArray(data?.items)) items = data.items;
  else if (Array.isArray(data?.data)) items = data.data;

  console.log(`[Casino] items: ${items.length}, buscando: ${username}`);

  const player = items.find((p: any) =>
    (p?.userName ?? p?.username ?? p?.UserName ?? '') === username
  );

  // Única rama que significa de verdad "este jugador no está": el casino contestó
  // JSON bien formado y aun así no hay match exacto.
  if (!player) {
    console.error(`[Casino] Player "${username}" no encontrado. Primeros 3:`, items.slice(0, 3));
    return { ok: false, reason: 'not_found' };
  }

  // El campo correcto del response de GetAgentWithChildren es accountId (número,
  // ej: 19923006), NO userId. Ese accountId es el targetId que espera DoDeposit.
  const accountId = player?.accountId ?? player?.AccountId ?? null;
  console.log(`[Casino] accountId extraído: ${accountId} (player.userName=${player?.userName ?? player?.UserName})`);
  if (accountId == null) {
    // El jugador aparece pero sin accountId: cambió la forma del response. No es
    // "no existe" — depositar a ciegas sería peor.
    console.error(`[Casino] Player "${username}" encontrado pero SIN accountId:`, JSON.stringify(player).slice(0, 300));
    return { ok: false, reason: 'casino_unavailable', detail: 'el casino devolvió el jugador sin accountId' };
  }
  return { ok: true, targetId: String(accountId) };
}

/** Por qué falló una acreditación. Lo consume el route para loguear y para decidir
 *  el mensaje: solo 'not_found' habla del jugador. */
export type CasinoCreditFailReason = 'not_found' | 'casino_unavailable' | 'deposit_rejected' | 'error';

export const CASINO_UNAVAILABLE_MSG =
  'El casino no está respondiendo. La carga NO se acreditó — reintentá en un minuto.';

export interface DoDepositResult {
  success: boolean;
  error?: string;
  reason?: CasinoCreditFailReason;
  /** Detalle técnico para el activity_log (no se le muestra al operador). */
  detail?: string;
}

export async function doDeposit(
  creds: CasinoCreds,
  params: { username: string; targetId: string; amount: number },
  deadlineAt?: number,
): Promise<DoDepositResult> {
  // El query param ?username= lleva el username del AGENTE (no el del player).
  const url = `${PROXY_URL}/api/services/app/Players/DoDeposit?username=${creds.agentUsername}`;

  // Body COMPLETO con contexto del agente. El casino lo exige: con el body
  // simplificado { targetId, amount } devuelve "Entidad no encontrada"; con este
  // devuelve 201 "Deposit Succesfull" (verificado en prod). targetId = accountId
  // (número), NO el userId string.
  const reqBody = JSON.stringify({
    username: params.username,
    userName: params.username,
    userType: 1,
    agentId: creds.agentId,
    agentUserName: creds.agentUsername,
    amount: params.amount,
    targetId: Number(params.targetId),
  });
  console.log('[Casino] DoDeposit URL:', url);
  console.log('[Casino] DoDeposit body completo:', reqBody);

  // DoDeposit es la acción que mueve plata: se le deja un piso de 2s aunque el
  // presupuesto esté casi agotado (llegar acá significa que el targetId ya se
  // resolvió). Sigue sin reintentarse nunca.
  const timeoutMs = deadlineAt
    ? Math.max(2_000, Math.min(CASINO_TIMEOUT_MS, remainingMs(deadlineAt)))
    : CASINO_TIMEOUT_MS;

  const res = await casinoFetch(url, {
    method: 'POST',
    headers: await casinoHeaders(creds, deadlineAt),
    body: reqBody,
  }, timeoutMs);

  const respText = await res.text().catch(() => '');
  console.log(`[Casino] DoDeposit resp status=${res.status} body completo:`, respText);

  // Un 401 significa que el casino NO autorizó la operación, así que el depósito no
  // se ejecutó. Se tira el token para que el siguiente intento salga con uno nuevo,
  // pero acá NO se reintenta: reintentar solo una operación que acredita plata es
  // justo lo que este módulo evita desde siempre. El operador reintenta y esa vez
  // ya arranca con token limpio.
  if (res.status === 401) {
    await invalidateCasinoToken(creds, true);
    console.warn('[Casino] DoDeposit: 401 con el token cacheado — token invalidado; NO se reintenta (mueve plata)');
  }

  if (res.status === 201) return { success: true };

  let errorBody = '';
  if (respText.trim().startsWith('{')) {
    try {
      const json = JSON.parse(respText);
      errorBody = json?.error?.message ?? json?.message ?? respText.substring(0, 200);
    } catch {
      errorBody = respText.substring(0, 200);
    }
  } else {
    errorBody = `HTTP ${res.status} - respuesta no JSON`;
  }

  console.error(`[Casino] DoDeposit falló: ${errorBody}`);
  return { success: false, error: errorBody, reason: 'deposit_rejected', detail: errorBody };
}

export async function creditPlayer(creds: CasinoCreds, username: string, amount: number): Promise<DoDepositResult> {
  // getPlayerTargetId / doDeposit pueden lanzar (incluido el timeout de casinoFetch).
  // Lo convertimos en un resultado para que el flujo de verificar comprobantes
  // responda un 400 limpio ("La recarga NO se verificó") en vez de un 500.
  // Presupuesto ÚNICO para todo el flujo (Authenticate + lookup + DoDeposit): es lo
  // que impide que la escalera de reintentos desborde el maxDuration del route.
  const deadlineAt = Date.now() + CREDIT_BUDGET_MS;

  try {
    const lookup = await getPlayerTargetId(creds, username, deadlineAt);
    if (!lookup.ok) {
      // Solo acá se puede afirmar que el jugador no está. Cualquier otra cosa es el
      // casino, y decir "no encontrado" manda al operador a buscar donde no es.
      if (lookup.reason === 'not_found') {
        return { success: false, error: `Player no encontrado en el casino: ${username}`, reason: 'not_found' };
      }
      return { success: false, error: CASINO_UNAVAILABLE_MSG, reason: 'casino_unavailable', detail: lookup.detail };
    }

    return await doDeposit(creds, { username, targetId: lookup.targetId, amount }, deadlineAt);
  } catch (err: any) {
    console.error('[Casino] creditPlayer error:', err?.message ?? err);
    return {
      success: false,
      error: err?.message ?? 'Error al acreditar en el casino',
      reason: 'error',
      detail: String(err?.message ?? err).slice(0, 300),
    };
  }
}

export interface CreatePlayerResult {
  success: boolean;
  username?: string;
  error?: string;
  /** El casino rechazó por nombre de usuario ya existente (para reintentar correlativo). */
  taken?: boolean;
}

// Crea un jugador en el casino. POST /api/services/app/Players/AddPlayer con
// { userName, password, skinIds: [SKIN_ID] }. Devuelve success en status 201.
// La contraseña debe tener ≥8 chars, 1 dígito, 1 mayúscula y 1 minúscula.
export async function createPlayer(creds: CasinoCreds, userName: string, password: string): Promise<CreatePlayerResult> {
  const url = `${PROXY_URL}/api/services/app/Players/AddPlayer`;
  const reqBody = JSON.stringify({ userName, password, skinIds: [creds.skinId] });
  console.log('[Casino] AddPlayer URL:', url, '— userName:', userName);

  let res: Response;
  try {
    res = await casinoFetch(url, { method: 'POST', headers: await casinoHeaders(creds), body: reqBody }, ADDPLAYER_TIMEOUT_MS);
  } catch (err: any) {
    console.error('[Casino] AddPlayer error de red:', err?.message ?? err);
    return { success: false, error: err?.message ?? 'Error de red al crear el usuario en el casino' };
  }

  const respText = await res.text().catch(() => '');
  // El body sólo en el camino de error. En un alta exitosa esa respuesta trae los
  // datos del jugador recién creado y no aporta nada al diagnóstico: el status y el
  // username ya dicen todo. Cuando falla sí hace falta ver qué contestó el casino.
  if (res.status === 201) {
    console.log(`[Casino] AddPlayer resp status=${res.status} usuario=${userName}`);
  } else {
    console.log(`[Casino] AddPlayer resp status=${res.status} body:`, respText.slice(0, 500));
  }

  // Mismo criterio que DoDeposit: se limpia el token, no se reintenta sola una
  // creación de jugador (un reintento a ciegas deja usuarios duplicados).
  if (res.status === 401) {
    await invalidateCasinoToken(creds, true);
    console.warn('[Casino] AddPlayer: 401 con el token cacheado — token invalidado; NO se reintenta (crea usuarios)');
  }

  if (res.status === 201) return { success: true, username: userName };

  let errorBody = '';
  if (respText.trim().startsWith('{')) {
    try {
      const json = JSON.parse(respText);
      errorBody = json?.error?.message ?? json?.message ?? respText.slice(0, 200);
    } catch {
      errorBody = respText.slice(0, 200);
    }
  } else {
    errorBody = `HTTP ${res.status} - respuesta no JSON`;
  }

  // Heurística para detectar "usuario ya existe" y poder reintentar correlativo.
  const taken = /exist|registr|ya .*us|taken|duplicad|en uso/i.test(errorBody);
  console.error(`[Casino] AddPlayer falló: ${errorBody}${taken ? ' (usuario tomado)' : ''}`);
  return { success: false, error: errorBody, taken };
}

// ── Test de conexión (Etapa 2, PR 4) ─────────────────────────────────────────
// Diagnóstico de credenciales para /api/casino/test-connection. A diferencia de
// getAgentBalance (que colapsa todo a null en el hot-path del depósito), DISTINGUE
// cada modo de falla para dar un mensaje específico en el form. NO toca tokenCache:
// usa el token fresco de SU propio Authenticate (probamos credenciales sin guardar,
// y no queremos envenenar el cache del flujo real).
export type CasinoTestFailReason =
  | 'bad_credentials'      // el casino RECHAZÓ el login (lo dijo él, no lo inferimos)
  | 'casino_unavailable'   // HTML de la SPA, 5xx, 429, body raro → NO es la contraseña
  | 'agent_not_found'
  | 'forbidden_target'
  | 'proxy_secret'
  | 'timeout'
  | 'unknown';

export type CasinoTestResult =
  | { ok: true; agentName: string; balance: number; authResultKeys: string[] }
  | { ok: false; reason: CasinoTestFailReason; detail?: string };

// Traduce una falla a su causa. Solo 'bad_credentials' habla de la contraseña, y
// se llega ahí únicamente si el casino lo dijo él mismo (ver isCredRejection).
function classifyFailure(r: CasinoJsonResult): CasinoTestFailReason {
  if (r.timedOut) return 'timeout';
  // 401 = rechazo de autenticación, tenga body o no. Va ANTES del chequeo de
  // notJson: este casino contesta un login malo con 401 y content-length 0
  // (verificado el 20/08/2026), así que con el orden inverso el body vacío se
  // comía el caso y una contraseña mal de verdad salía como "casino caído".
  // El 401 del Worker (X-Proxy-Secret inválido) ya se filtró antes de llegar acá.
  if (r.status === 401) return 'bad_credentials';
  // El 403 queda abajo a propósito: un 403 con HTML es casi siempre un WAF o un
  // bloqueo del casino, no una credencial.
  if (r.notJson) return 'casino_unavailable';   // ← el caso de los logs del 19-20/08
  // El casino contestó JSON bien formado: su propio mensaje de error manda por
  // encima del status (ABP devuelve el rechazo de login también con 500).
  if (isCredRejection(r)) return 'bad_credentials';
  if (r.status === 403) return 'bad_credentials';
  if (r.status === 429 || r.status >= 500)  return 'casino_unavailable';
  return 'unknown';
}

// Nunca loguea la contraseña. Sin esto los intentos fallidos eran invisibles:
// testCasinoConnection solo logueaba en el éxito, así que los tests de las 14:05 y
// 14:26 del 20/08 no dejaron ni una línea.
function logTestFailure(creds: CasinoCreds, stage: string, reason: string, r: CasinoJsonResult) {
  console.error(
    `[Casino] test-connection FALLÓ stage=${stage} reason=${reason} tenant=${creds.tenantId} ` +
    `agente=${creds.agentUsername} target=${creds.skinDomain} http=${r.status} intentos=${r.attempts} ` +
    `content-type=${r.res?.headers.get('content-type') ?? '-'} ${proxyDiag(r.res)} — body(300): ${r.body.slice(0, 300).replace(/\s+/g, ' ')}`,
  );
}

export async function testCasinoConnection(creds: CasinoCreds): Promise<CasinoTestResult> {
  // ── 1) Authenticate (login del agente) ──────────────────────────────────────
  const a = await casinoFetchJson(`${PROXY_URL}/api/TokenAuth/Authenticate`, {
    method: 'POST',
    headers: proxyHeaders(creds.skinDomain),
    body: JSON.stringify({
      userNameOrEmailAddress: creds.agentUsername,
      password: creds.agentPassword,
      skinDomain: creds.skinDomain,
    }),
  }, { label: 'test/Authenticate' });

  // Rechazos del WORKER (texto plano), antes de clasificar nada del casino.
  // 403 = el skin_domain no está en el allowlist ("casino todavía no habilitado").
  if (a.status === 403 && /forbidden casino target/i.test(a.body)) {
    logTestFailure(creds, 'Authenticate', 'forbidden_target', a);
    return { ok: false, reason: 'forbidden_target' };
  }
  // 401 "Unauthorized" texto plano = X-Proxy-Secret inválido (infra, no credenciales).
  if (a.status === 401 && /^unauthorized$/i.test(a.body.trim())) {
    logTestFailure(creds, 'Authenticate', 'proxy_secret', a);
    return { ok: false, reason: 'proxy_secret', detail: 'Proxy secret inválido' };
  }

  const token: string | null = a.json?.result?.accessToken ?? null;
  if (!token) {
    // Antes TODO esto caía en bad_credentials → "Usuario o contraseña incorrectos"
    // aunque el casino estuviera devolviendo HTML. Ahora se distingue la causa.
    const reason = classifyFailure(a);
    logTestFailure(creds, 'Authenticate', reason, a);
    return { ok: false, reason };
  }

  // Solo los NOMBRES de campos del result (sin valores/tokens): confirma si
  // Authenticate ya trae agentId/skinId (pregunta de diseño del PR 4).
  const authResultKeys =
    a.json?.result && typeof a.json.result === 'object' ? Object.keys(a.json.result) : [];

  // ── 2) GetAgentBalance (prueba concreta: saldo real del agente) ──────────────
  const params = new URLSearchParams({ agentId: creds.agentId, username: creds.agentUsername });
  const b = await casinoFetchJson(
    `${PROXY_URL}/api/services/app/Agent/GetAgentBalance?${params}`,
    { method: 'GET', headers: proxyHeaders(creds.skinDomain, { Authorization: `Bearer ${token}` }) },
    { label: 'test/GetAgentBalance' },
  );

  if (b.status === 403 && /forbidden casino target/i.test(b.body)) {
    logTestFailure(creds, 'GetAgentBalance', 'forbidden_target', b);
    return { ok: false, reason: 'forbidden_target' };
  }
  // El saldo arrastraba el mismo bug que el login: si volvía HTML decía "no
  // encontramos ese ID de agente". Pasó el 19/08 22:42:51 (login OK + saldo HTML).
  if (b.timedOut || b.notJson || b.status === 429 || b.status >= 500) {
    const reason: CasinoTestFailReason = b.timedOut ? 'timeout' : 'casino_unavailable';
    logTestFailure(creds, 'GetAgentBalance', reason, b);
    return { ok: false, reason };
  }

  const balance = Number(b.json?.result);
  if (!Number.isFinite(balance)) {
    // Recién acá: el casino contestó JSON bien formado y aun así no hay saldo →
    // el agentId no existe / no cuelga de este login. Ese sí es de configuración.
    logTestFailure(creds, 'GetAgentBalance', 'agent_not_found', b);
    return { ok: false, reason: 'agent_not_found', detail: b.body.slice(0, 200) };
  }

  console.log(
    `[Casino] test-connection OK tenant=${creds.tenantId} agente=${creds.agentUsername} ` +
    `target=${creds.skinDomain} saldo=${balance} intentos=auth:${a.attempts}/bal:${b.attempts} ` +
    `result keys: ${authResultKeys.join(', ')}`,
  );
  return { ok: true, agentName: creds.agentUsername, balance, authResultKeys };
}
