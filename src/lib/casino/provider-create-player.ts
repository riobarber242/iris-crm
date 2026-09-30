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

  let result = await provider.createPlayer(ctx, username, password);
  let attempts = 0;
  while (!result.ok && result.taken && attempts < MAX_CORRELATIVE_ATTEMPTS) {
    username = nextUsername(username);
    result = await provider.createPlayer(ctx, username, password);
    attempts++;
  }

  // Alta ambigua: quizás el casino SÍ lo creó. Solo un lookup OK lo confirma; si el
  // lookup tampoco contesta, se informa la falla y el operador reintenta.
  if (!result.ok && result.ambiguous && provider.playerBalance) {
    const lookup = await provider.playerBalance(ctx, username);
    if (lookup.ok) {
      console.log(`[create-player/${provider.id}] alta ambigua pero el usuario existe → creado: ${username}`);
      result = { ok: true };
    }
  }

  if (!result.ok) {
    return NextResponse.json({ success: false, error: result.error }, { status: 502 });
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
