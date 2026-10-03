// src/lib/casino/providers/agentesplus-panel.ts
// Lectura del SALDO DEL AGENTE desde el panel web de agentes.plus. La API (rol
// cashier) no lo expone y el casino no tiene fecha para hacerlo, así que IRIS entra
// al panel con el usuario y la contraseña del agente y lee "Saldo disponible".
// SOLO LECTURA: nada de este módulo crea, deposita ni retira (eso sigue por la API).
//
// Cómo es el panel (relevado el 02/10/2026 desde un navegador logueado):
//   · Login: POST /index.php multipart {username, password, ajax=1} con el header
//     X-Requested-With → JSON {ok:true, redirect} | {ok:false, error}. Sin CSRF ni
//     captcha. La sesión es la cookie PHPSESSID (de sesión, sin vencimiento propio).
//   · GET /dashboard.php trae el saldo RENDERIZADO en el HTML:
//       <div class="balance">Saldo disponible: <span data-current-agent-balance>463.807,00</span></div>
//     Formato es-AR (punto de miles, coma decimal), sin "$".
//   · Sin sesión válida, dashboard.php responde 302 a index.php.
//   · Admite sesiones simultáneas del mismo usuario (dato del dueño de la cuenta): el
//     login de IRIS no debería desloguear a nadie. Se confirma en la prueba manual.
//
// Cache de sesión: tabla casino_sessions (una fila por cuenta, cookie CIFRADA). La
// tabla es la misma del token de 17Star, pero cada fila es de una cuenta distinta y
// este módulo no usa el código de celuapuestas.
//
// Contrato: NUNCA lanza. Toda falla vuelve como { ok:false } con el motivo; el que
// llama decide (mostrar "saldo no disponible"). Ni la contraseña ni la cookie se
// loguean jamás.

import { supabaseAdmin } from '@/lib/db';
import { decryptSecret, encryptSecret } from '@/lib/secure-secret';
import type { ProviderContext, ProviderFailReason, ProviderTestResult } from './types';

export const AGENTESPLUS_PANEL_DEFAULT_URL = 'https://agentes.plus';

const REQUEST_TIMEOUT_MS = 10_000;
// La cookie no trae vencimiento: se asume corta (el default de PHP son 24 min sin
// uso) y se renueva al verla rechazada (302).
const SESSION_TTL_MS = 20 * 60_000;
const SESSION_REFRESH_BELOW_MS = 10 * 60_000;
// Después de un "Credenciales inválidas", no se vuelve a intentar el login por un
// rato: reintentar en loop puede bloquear la cuenta del agente.
const BAD_CREDENTIALS_COOLDOWN_MS = 15 * 60_000;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';

export type PanelBalanceResult =
  | { ok: true; balance: number; raw: string; reusedSession: boolean; ms: number }
  | { ok: false; reason: ProviderFailReason; error: string; ms: number };

export function hasPanelCredentials(ctx: ProviderContext): boolean {
  return !!(ctx.values.panel_user?.trim() && ctx.secrets.panel_password);
}

function panelBase(ctx: ProviderContext): string {
  const u = (ctx.values.panel_url ?? '').trim() || AGENTESPLUS_PANEL_DEFAULT_URL;
  return u.replace(/\/+$/, '');
}

// ── Salida: directo o por el VPS argentino ───────────────────────────────────
// El Cloudflare de agentes.plus devuelve 403 al login del panel cuando el pedido
// sale de Vercel (02/10/2026, confirmado con un usuario inventado); desde el VPS
// argentino contesta normal. Por eso el panel sale por el mismo proxy (Caddy) que
// usa 17Star, con agentes.plus en su allowlist. SOLO el panel: la API (api.php)
// sigue directo desde agentesplus.ts.
//
// El proxy es infraestructura de IRIS (CASINO_PROXY_URL / CASINO_PROXY_SECRET, las
// mismas env de 17Star), no un dato del tenant. Si el VPS se cae, el saldo queda
// "no disponible" y nada más: las cargas no dependen de esto.

export const PANEL_VIA_DEFAULT = 'vps';
export const PANEL_VIA_VALUES = ['vps', 'directo'] as const;
type PanelVia = (typeof PANEL_VIA_VALUES)[number];

function panelVia(ctx: ProviderContext): PanelVia | null {
  const v = (ctx.values.panel_via ?? '').trim().toLowerCase() || PANEL_VIA_DEFAULT;
  return (PANEL_VIA_VALUES as readonly string[]).includes(v) ? (v as PanelVia) : null;
}

type Route = { ok: true; url: (path: string) => string; headers: Record<string, string>; via: PanelVia } | { ok: false; error: string };

function route(ctx: ProviderContext): Route {
  const via = panelVia(ctx);
  if (!via) return { ok: false, error: `"Salida del panel" inválida: tiene que ser ${PANEL_VIA_VALUES.join(' o ')}.` };
  const base = panelBase(ctx);
  if (via === 'directo') return { ok: true, via, url: (p) => `${base}${p}`, headers: {} };
  const proxy = (process.env.CASINO_PROXY_URL ?? '').trim().replace(/\/+$/, '');
  const secret = process.env.CASINO_PROXY_SECRET ?? '';
  if (!proxy || !secret) return { ok: false, error: 'El proxy de IRIS no está configurado (CASINO_PROXY_URL / CASINO_PROXY_SECRET).' };
  let host: string;
  try { host = new URL(base).host; } catch { return { ok: false, error: 'La URL del panel no es válida.' }; }
  return { ok: true, via, url: (p) => `${proxy}${p}`, headers: { 'X-Proxy-Secret': secret, 'X-Casino-Target': host } };
}

/**
 * Diagnóstico de una respuesta inesperada: status y headers que dicen QUIÉN contestó
 * (Cloudflare, el proxy, el panel) y un recorte del body. Nunca credenciales: se
 * tachan usuario, contraseña y secreto del proxy si aparecieran en el body, y no se
 * imprime ningún header de cookies.
 */
function logUnexpected(ctx: ProviderContext, stage: string, via: PanelVia, res: Response, body: string) {
  let snippet = body.replace(/\s+/g, ' ').trim();
  for (const s of [ctx.secrets.panel_password, ctx.values.panel_user, process.env.CASINO_PROXY_SECRET]) {
    if (s && s.length >= 3) snippet = snippet.split(s).join('***');
  }
  const title = snippet.match(/<title[^>]*>([^<]{0,80})/i)?.[1]?.trim() ?? '-';
  console.warn(
    `[agentesplus-panel] ${stage} respuesta inesperada tenant=${ctx.tenantId} via=${via} http=${res.status}` +
    ` ct="${res.headers.get('content-type') ?? '-'}" server="${res.headers.get('server') ?? '-'}"` +
    ` cf-ray=${res.headers.get('cf-ray') ? 'sí' : 'no'} proxy=${res.headers.get('x-proxy-colo') ?? '-'}` +
    ` title="${title}" body="${snippet.slice(0, 200)}"`,
  );
}

/** Texto para el operador ante una respuesta que no es del panel (proxy o Cloudflare). */
function describeUnexpected(res: Response, body: string, via: PanelVia): string {
  const t = body.trim();
  if (via === 'vps' && res.status === 401 && /^unauthorized$/i.test(t)) return 'El proxy de IRIS rechazó el pedido (secreto).';
  if (via === 'vps' && res.status === 403 && /forbidden casino target/i.test(t)) return 'El proxy de IRIS no tiene habilitado el panel de agentes.plus.';
  if (via === 'vps' && res.status === 502) return 'El proxy de IRIS no pudo llegar al panel de agentes.plus.';
  return `El panel de agentes.plus respondió algo inesperado (HTTP ${res.status}).`;
}

// ── Parser (puro, exportado para la prueba offline) ──────────────────────────

const ARS_RE = /^-?\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?$/;

/** "463.807,00" → 463807. null si no tiene el formato esperado. */
export function parseArsAmount(text: string): number | null {
  const s = String(text ?? '').replace(/[\s ]/g, '').replace(/^\$/, '');
  if (!ARS_RE.test(s)) return null;
  const n = Number(s.replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/**
 * Saca "Saldo disponible" del HTML del dashboard. Primero el span marcado con
 * data-current-agent-balance (el ancla estable); si cambiaran el marcado, el número
 * que sigue a la etiqueta. null si no aparece o el número no tiene formato es-AR.
 */
export function parseDashboardBalance(html: string): { balance: number; raw: string } | null {
  const tries = [
    /<[a-z]+[^>]*\bdata-current-agent-balance\b[^>]*>\s*([^<]{1,40}?)\s*</i,
    /Saldo\s+disponible\s*:?\s*(?:<[^>]*>\s*)*([-$\d.,\s ]{1,40}?)\s*</i,
  ];
  for (const re of tries) {
    const m = html.match(re);
    if (!m) continue;
    const balance = parseArsAmount(m[1]);
    if (balance !== null) return { balance, raw: m[1].replace(/[\s ]+/g, ' ').trim().replace(/^\$\s*/, '') };
  }
  return null;
}

// ── HTTP con cookies mínimas ─────────────────────────────────────────────────

type Jar = Record<string, string>;

function absorbCookies(jar: Jar, res: Response) {
  const h = res.headers as Headers & { getSetCookie?: () => string[] };
  const list = typeof h.getSetCookie === 'function' ? h.getSetCookie() : (res.headers.get('set-cookie') ?? '').split(/,(?=\s*[A-Za-z0-9_]+=)/);
  for (const c of list) {
    const m = c.match(/^\s*([^=;\s]+)=([^;]*)/);
    if (m) jar[m[1]] = m[2];
  }
}

const cookieHeader = (jar: Jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

function jarFromHeader(header: string): Jar {
  const jar: Jar = {};
  for (const part of header.split(';')) {
    const m = part.match(/^\s*([^=\s]+)=(.*)$/);
    if (m) jar[m[1]] = m[2];
  }
  return jar;
}

async function req(url: string, init: RequestInit): Promise<{ res: Response | null; timedOut: boolean; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, redirect: 'manual', cache: 'no-store', signal: controller.signal });
    return { res, timedOut: false };
  } catch (err: any) {
    const timedOut = err?.name === 'AbortError';
    return { res: null, timedOut, error: timedOut ? 'sin respuesta a tiempo' : String(err?.message ?? 'error de red').slice(0, 120) };
  } finally {
    clearTimeout(timer);
  }
}

type LoginResult = { ok: true; jar: Jar } | { ok: false; reason: ProviderFailReason; error: string };

const noResponse = (via: PanelVia, error?: string) =>
  via === 'vps'
    ? `No se pudo llegar al panel de agentes.plus por el proxy de IRIS (${error}).`
    : `El panel de agentes.plus no respondió (${error}).`;

async function login(ctx: ProviderContext): Promise<LoginResult> {
  const rt = route(ctx);
  if (!rt.ok) return { ok: false, reason: 'invalid', error: rt.error };
  const jar: Jar = {};
  // GET previo: como el navegador, se arranca con la cookie que da el formulario.
  const pre = await req(rt.url('/index.php'), { method: 'GET', headers: { ...rt.headers, 'User-Agent': UA } });
  // Sin respuesta acá (VPS caído, red): cortar ya y no comerse otro timeout en el POST.
  if (!pre.res) return { ok: false, reason: pre.timedOut ? 'timeout' : 'unavailable', error: noResponse(rt.via, pre.error) };
  absorbCookies(jar, pre.res); await pre.res.text().catch(() => '');

  const form = new FormData();
  form.set('username', ctx.values.panel_user.trim());
  form.set('password', ctx.secrets.panel_password);
  form.set('ajax', '1');
  const r = await req(rt.url('/index.php'), {
    method: 'POST',
    body: form,
    headers: { ...rt.headers, 'User-Agent': UA, 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json', Cookie: cookieHeader(jar) },
  });
  if (!r.res) return { ok: false, reason: r.timedOut ? 'timeout' : 'unavailable', error: noResponse(rt.via, r.error) };
  absorbCookies(jar, r.res); // el login regenera la sesión: vale la ÚLTIMA PHPSESSID
  const text = await r.res.text().catch(() => '');
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* HTML / texto: Cloudflare, el proxy o cambio de página */ }
  if (r.res.status === 200 && json?.ok === true && jar.PHPSESSID) return { ok: true, jar };
  // Credencial mala SOLO cuando el panel mismo lo dijo (JSON ok:false). Un 401/403
  // del proxy o de Cloudflare es texto/HTML y cae abajo como "no disponible".
  if (r.res.status === 200 && json && json.ok === false) {
    const motivo = String(json.error ?? '').replace(/\s+/g, ' ').slice(0, 120);
    return { ok: false, reason: 'bad_credentials', error: `El panel de agentes.plus rechazó el usuario o la contraseña${motivo ? ` ("${motivo}")` : ''}.` };
  }
  logUnexpected(ctx, 'login', rt.via, r.res, text);
  return { ok: false, reason: 'unavailable', error: describeUnexpected(r.res, text, rt.via) };
}

type DashResult =
  | { kind: 'ok'; balance: number; raw: string }
  | { kind: 'expired' }
  | { kind: 'fail'; reason: ProviderFailReason; error: string };

async function readDashboard(ctx: ProviderContext, jar: Jar): Promise<DashResult> {
  const rt = route(ctx);
  if (!rt.ok) return { kind: 'fail', reason: 'invalid', error: rt.error };
  const r = await req(rt.url('/dashboard.php'), {
    method: 'GET', headers: { ...rt.headers, 'User-Agent': UA, Cookie: cookieHeader(jar) },
  });
  if (!r.res) return { kind: 'fail', reason: r.timedOut ? 'timeout' : 'unavailable', error: noResponse(rt.via, r.error) };
  const html = await r.res.text().catch(() => '');
  if (r.res.status >= 300 && r.res.status < 400) return { kind: 'expired' };
  if (r.res.status !== 200) {
    logUnexpected(ctx, 'dashboard', rt.via, r.res, html);
    return { kind: 'fail', reason: 'unavailable', error: describeUnexpected(r.res, html, rt.via) };
  }
  const parsed = parseDashboardBalance(html);
  if (!parsed) {
    // El formulario de login con 200 también es "sin sesión".
    if (/id=["']login-form["']/.test(html)) return { kind: 'expired' };
    logUnexpected(ctx, 'dashboard sin saldo', rt.via, r.res, html.slice(0, 2000));
    return { kind: 'fail', reason: 'unavailable', error: 'No se encontró "Saldo disponible" en el panel (¿cambió la página?).' };
  }
  return { kind: 'ok', ...parsed };
}

// ── Cache de sesión (casino_sessions) ────────────────────────────────────────
// Nunca lanza: una falla de la base es "no hay nada guardado".

interface StoredPanel { jar: Jar | null; expiresAt: number; last401At: number | null }

async function readStored(ctx: ProviderContext): Promise<StoredPanel | null> {
  if (!ctx.accountId) return null;
  try {
    const { data, error } = await supabaseAdmin
      .from('casino_sessions').select('access_token_enc, expires_at, last_401_at')
      .eq('account_id', ctx.accountId).maybeSingle();
    if (error || !data) return null;
    const expiresAt = new Date(data.expires_at).getTime();
    const last401At = data.last_401_at ? new Date(data.last_401_at).getTime() : null;
    let jar: Jar | null = null;
    if (Number.isFinite(expiresAt) && Date.now() < expiresAt && data.access_token_enc) {
      try { const h = decryptSecret(data.access_token_enc); jar = h ? jarFromHeader(h) : null; } catch { jar = null; }
    }
    return { jar, expiresAt, last401At };
  } catch (err: any) {
    console.warn('[agentesplus-panel] lectura de sesión falló:', err?.message ?? err);
    return null;
  }
}

async function writeStored(ctx: ProviderContext, jar: Jar): Promise<void> {
  if (!ctx.accountId) return;
  try {
    const { error } = await supabaseAdmin.from('casino_sessions').upsert({
      account_id: ctx.accountId,
      tenant_id: ctx.tenantId,
      access_token_enc: encryptSecret(cookieHeader(jar)),
      expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
      obtained_at: new Date().toISOString(),
      last_401_at: null,
    }, { onConflict: 'account_id' });
    if (error) console.warn('[agentesplus-panel] escritura de sesión falló:', error.message);
  } catch (err: any) {
    console.warn('[agentesplus-panel] escritura de sesión falló:', err?.message ?? err);
  }
}

async function markBadCredentials(ctx: ProviderContext): Promise<void> {
  if (!ctx.accountId) return;
  try {
    const { error } = await supabaseAdmin.from('casino_sessions').upsert({
      account_id: ctx.accountId,
      tenant_id: ctx.tenantId,
      access_token_enc: encryptSecret(''),
      expires_at: new Date(0).toISOString(),
      obtained_at: new Date().toISOString(),
      last_401_at: new Date().toISOString(),
    }, { onConflict: 'account_id' });
    if (error) console.warn('[agentesplus-panel] marca de credencial mala falló:', error.message);
  } catch (err: any) {
    console.warn('[agentesplus-panel] marca de credencial mala falló:', err?.message ?? err);
  }
}

// Un login por cuenta a la vez dentro de la instancia (varias pestañas pidiendo el
// saldo al mismo tiempo no disparan varios logins).
const loginsInFlight = new Map<string, Promise<LoginResult>>();

function sharedLogin(ctx: ProviderContext): Promise<LoginResult> {
  const key = ctx.accountId || `typed:${ctx.tenantId}`;
  const running = loginsInFlight.get(key);
  if (running) return running;
  const p = login(ctx).finally(() => loginsInFlight.delete(key));
  loginsInFlight.set(key, p);
  return p;
}

// ── API del módulo ───────────────────────────────────────────────────────────

/**
 * Saldo del agente reusando la sesión guardada. Si la sesión venció, UN re-login y
 * un reintento. Respeta la pausa tras credenciales malas.
 */
export async function readPanelBalance(ctx: ProviderContext): Promise<PanelBalanceResult> {
  const t0 = Date.now();
  const fail = (reason: ProviderFailReason, error: string): PanelBalanceResult => {
    console.warn(`[agentesplus-panel] saldo FALLÓ tenant=${ctx.tenantId} motivo=${reason} ms=${Date.now() - t0}`);
    return { ok: false, reason, error, ms: Date.now() - t0 };
  };
  if (!hasPanelCredentials(ctx)) return fail('bad_credentials', 'Faltan el usuario o la contraseña del panel de agentes.plus.');

  const stored = await readStored(ctx);
  if (stored?.jar) {
    const d = await readDashboard(ctx, stored.jar);
    if (d.kind === 'ok') {
      if (stored.expiresAt - Date.now() < SESSION_REFRESH_BELOW_MS) await writeStored(ctx, stored.jar);
      console.log(`[agentesplus-panel] saldo OK tenant=${ctx.tenantId} sesión=reusada ms=${Date.now() - t0}`);
      return { ok: true, balance: d.balance, raw: d.raw, reusedSession: true, ms: Date.now() - t0 };
    }
    if (d.kind === 'fail') return fail(d.reason, d.error);
    // expired → re-login abajo
  }

  if (stored?.last401At && Date.now() - stored.last401At < BAD_CREDENTIALS_COOLDOWN_MS) {
    const min = Math.ceil((BAD_CREDENTIALS_COOLDOWN_MS - (Date.now() - stored.last401At)) / 60_000);
    return fail('bad_credentials', `El panel rechazó la contraseña hace poco; IRIS no reintenta por ${min} min para no bloquear la cuenta.`);
  }

  const lg = await sharedLogin(ctx);
  if (!lg.ok) {
    if (lg.reason === 'bad_credentials') await markBadCredentials(ctx);
    return fail(lg.reason, lg.error);
  }
  await writeStored(ctx, lg.jar);
  const d = await readDashboard(ctx, lg.jar);
  if (d.kind === 'ok') {
    console.log(`[agentesplus-panel] saldo OK tenant=${ctx.tenantId} sesión=nueva ms=${Date.now() - t0}`);
    return { ok: true, balance: d.balance, raw: d.raw, reusedSession: false, ms: Date.now() - t0 };
  }
  if (d.kind === 'expired') return fail('unavailable', 'El panel no aceptó la sesión recién abierta.');
  return fail(d.reason, d.error);
}

/**
 * Prueba de los datos del panel (al guardarlos o con "Probar conexión"): login
 * NUEVO con lo tipeado y lectura del saldo. No lee ni escribe el cache ni la pausa:
 * los datos pueden no estar guardados todavía.
 */
export async function testPanel(ctx: ProviderContext): Promise<ProviderTestResult & { balance?: number }> {
  if (!ctx.values.panel_user?.trim()) return { ok: false, reason: 'invalid', error: 'Falta el usuario del panel.' };
  if (!ctx.secrets.panel_password) return { ok: false, reason: 'invalid', error: 'Falta la contraseña del panel.' };
  const lg = await login(ctx);
  if (!lg.ok) return { ok: false, reason: lg.reason, error: lg.error };
  const d = await readDashboard(ctx, lg.jar);
  if (d.kind === 'ok') {
    return { ok: true, balance: d.balance, message: `Panel de agentes.plus OK: saldo disponible $${d.raw}.` };
  }
  if (d.kind === 'expired') return { ok: false, reason: 'unavailable', error: 'El panel no aceptó la sesión recién abierta.' };
  return { ok: false, reason: d.reason, error: d.error };
}
