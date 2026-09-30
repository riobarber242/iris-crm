// src/lib/casino/provider-create-player.ts
// Alta de jugador para los proveedores del MODELO NUEVO (los que no corren por el
// código propio de celuapuestas). Lo llama POST /api/casino/create-player después de
// sus gates (plan, sesión, rol, flag del tenant) cuando loadNonLegacyAccount() devuelve
// una conexión. Mismo contrato de respuesta que el camino de celuapuestas:
//   { success, username, password, message } | { success: false, error }
// y mismas reglas: el contacto es del tenant, no se pisa un usuario ya cargado,
// correlativo si el usuario está tomado, y un alta ambigua (timeout / 5xx) se confirma
// con un lookup antes de darla por fallida (evita duplicar el usuario al reintentar).

import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { logActivity } from '@/lib/activity-log';
import type { SessionPayload } from '@/lib/session';
import { renderCredentials } from './credentials';
import type { CasinoProvider, ProviderContext } from './providers/types';

const MAX_CORRELATIVE_ATTEMPTS = 20;

// Presupuesto del flujo de alta. Los routes que lo usan declaran maxDuration = 60.
// Se reserva la cola para confirmar por saldo un alta que quedó ambigua.
// Cuentas: el alta tiene hasta 55 - 20 = 35s; si se cuelga entera, en los 20s de
// reserva entran dos consultas de confirmación (3s + 4s y 7s + 4s).
export const CREATE_FLOW_BUDGET_MS = 55_000;
export const CREATE_CONFIRM_RESERVE_MS = 20_000;
// Esperas entre consultas de confirmación y techo de cada consulta.
const CONFIRM_WAITS_MS = [3_000, 7_000, 10_000];
const CONFIRM_READ_TIMEOUT_MS = 4_000;

export const AMBIGUOUS_CREATE_MSG =
  'No se pudo confirmar si el usuario se creó en el casino. Antes de reintentar, esperá un minuto y ' +
  'buscalo en el panel del casino (o consultá su saldo): si ya existe, cargalo a mano en el contacto.';

/**
 * Después de un alta ambigua (timeout, 5xx), consulta el saldo del jugador unas
 * veces, espaciadas, para detectar un alta que terminó tarde. Solo un saldo OK
 * confirma que existe. Respeta `deadlineAt` (no se pasa del maxDuration).
 */
export async function confirmPlayerCreated(
  provider: CasinoProvider, ctx: ProviderContext, username: string, deadlineAt: number,
): Promise<boolean> {
  if (!provider.playerBalance) return false;
  for (const wait of CONFIRM_WAITS_MS) {
    if (deadlineAt - Date.now() < wait + CONFIRM_READ_TIMEOUT_MS) break;
    await new Promise((r) => setTimeout(r, wait));
    const r = await provider.playerBalance(ctx, username, { timeoutMs: CONFIRM_READ_TIMEOUT_MS, retry: false });
    if (r.ok) {
      console.log(`[create-player/${provider.id}] alta ambigua confirmada por saldo: ${username} existe`);
      return true;
    }
  }
  return false;
}

// "<base><n>js" → "<base><n+1>js"; si no matchea, agrega un 2. Igual que el camino
// de celuapuestas, para que los usuarios de todos los tenants se vean iguales.
function nextUsername(username: string): string {
  const m = username.match(/^(.*?)(\d+)js$/i);
  if (m) return `${m[1]}${Number(m[2]) + 1}js`;
  return `${username}2`;
}

export async function createPlayerWithProvider(
  session: SessionPayload,
  request: Request,
  account: { provider: CasinoProvider; ctx: ProviderContext; row: any },
): Promise<NextResponse> {
  const { provider, ctx, row } = account;
  if (!provider.createPlayer) {
    return NextResponse.json({ success: false, error: `El proveedor ${provider.label} no permite crear usuarios desde IRIS.` }, { status: 501 });
  }

  const body = await request.json().catch(() => ({} as any));
  const contactId = typeof body.contactId === 'string' ? body.contactId.trim() : '';
  let username = typeof body.suggestedUsername === 'string' ? body.suggestedUsername.trim().toLowerCase() : '';
  if (!contactId) return NextResponse.json({ success: false, error: 'Falta contactId' }, { status: 400 });
  if (!username)  return NextResponse.json({ success: false, error: 'Falta el username sugerido' }, { status: 400 });

  const { data: contact } = await supabaseAdmin
    .from('contacts').select('id, casino_username, tenant_id')
    .eq('id', contactId).eq('tenant_id', session.tenant_id).maybeSingle();
  if (!contact) return NextResponse.json({ success: false, error: 'Contacto no encontrado' }, { status: 404 });
  if (contact.casino_username) {
    return NextResponse.json({ success: false, error: `El contacto ya tiene usuario: ${contact.casino_username}` }, { status: 409 });
  }

  const providedPassword = typeof body.password === 'string' ? body.password.trim() : '';
  const password = providedPassword || provider.password.generate();
  if (!provider.password.rule.test(password)) {
    return NextResponse.json({ success: false, error: provider.password.ruleText }, { status: 400 });
  }

  const deadlineAt = Date.now() + CREATE_FLOW_BUDGET_MS;
  const createDeadline = deadlineAt - CREATE_CONFIRM_RESERVE_MS;
  let result = await provider.createPlayer(ctx, username, password, { deadlineAt: createDeadline });
  let attempts = 0;
  while (!result.ok && result.taken && attempts < MAX_CORRELATIVE_ATTEMPTS) {
    username = nextUsername(username);
    result = await provider.createPlayer(ctx, username, password, { deadlineAt: createDeadline });
    attempts++;
  }

  // Alta ambigua: quizás el casino SÍ lo creó (o lo termina de crear en unos
  // segundos). Solo un saldo OK lo confirma; si no aparece, se avisa que no se sabe,
  // para que el operador no reintente a ciegas y duplique el usuario.
  if (!result.ok && result.ambiguous) {
    if (await confirmPlayerCreated(provider, ctx, username, deadlineAt)) result = { ok: true };
  }

  if (!result.ok) {
    // En un alta ambigua van usuario y contraseña: si aparece más tarde en el panel,
    // es la contraseña que quedó (mismo criterio que el camino de celuapuestas).
    return NextResponse.json(result.ambiguous
      ? { success: false, error: `${result.error} ${AMBIGUOUS_CREATE_MSG}`, username, password }
      : { success: false, error: result.error }, { status: 502 });
  }

  const { error: updErr } = await supabaseAdmin
    .from('contacts').update({ casino_username: username })
    .eq('id', contactId).eq('tenant_id', session.tenant_id);
  if (updErr) {
    return NextResponse.json({
      success: false,
      error: `Usuario creado en el casino (${username}) pero no se pudo guardar en el contacto: ${updErr.message}`,
      username, password,
    }, { status: 500 });
  }

  // Texto de credenciales con los datos de la fila del tenant (sin fallback a
  // settings ni env: los proveedores nuevos nacen con todo en casino_accounts).
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const message = renderCredentials(str(row?.credentials_template) || null, {
    username, password, link1: str(row?.player_url), link2: str(row?.player_url_2),
  });

  await logActivity({
    session, action: 'casino_create_player', objectType: 'contact', objectId: contactId,
    details: { username, provider: provider.id },
  });

  return NextResponse.json({ success: true, username, password, message });
}
