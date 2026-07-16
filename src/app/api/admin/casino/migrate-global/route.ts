import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { requireAdmin } from '@/lib/current-agent';
import { encryptSecret, isSecretEncryptionConfigured } from '@/lib/secure-secret';

// POST /api/admin/casino/migrate-global — Etapa 2, PR 1 (seed único e idempotente).
//
// Migra la cuenta de casino mono-global (env vars gonza0106 / CeluApuestas) a una
// fila en casino_accounts para el ÚNICO tenant que hoy tiene el casino activado
// (casino_deposit_enabled='true'). Corre en Vercel porque necesita a la vez el
// password del agente (env CASINO_AGENT_PASSWORD) y la clave de cifrado
// (SECRET_ENC_KEY) — ninguno de los dos toca el disco local ni este repo.
//
// Idempotente: si ya existe la fila default del tenant, la actualiza (re-cifra);
// si no, la inserta. connection_verified_at queda NULL (se verifica en el PR 4).
// Devuelve un resumen SIN secretos.

const CASINO_KEYS = [
  'casino_api_base_url',
  'casino_player_url',
  'casino_player_url_2',
  'casino_credentials_template',
] as const;

export async function POST() {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: 'Requiere rol admin' }, { status: 403 });
  }

  // Fail-closed: sin clave de cifrado no seguimos (no queremos guardar el password
  // en claro ni a medias).
  if (!isSecretEncryptionConfigured()) {
    return NextResponse.json({ error: 'Falta SECRET_ENC_KEY (clave de cifrado) en el entorno' }, { status: 500 });
  }

  const password = process.env.CASINO_AGENT_PASSWORD ?? '';
  if (!password) {
    return NextResponse.json({ error: 'CASINO_AGENT_PASSWORD vacío en el entorno; no hay password que sembrar' }, { status: 500 });
  }

  // Censo: seedeamos SOLO si hay exactamente 1 tenant con el flag en true. Las env
  // son de UNA cuenta global; sembrar varias desde la misma env las cablearía a
  // todas al casino de gonza0106. 0 o >1 → error, no adivinamos.
  const { data: enabled, error: enErr } = await supabaseAdmin
    .from('settings').select('tenant_id')
    .eq('key', 'casino_deposit_enabled').eq('value', 'true');
  if (enErr) return NextResponse.json({ error: enErr.message }, { status: 500 });
  if (!enabled || enabled.length !== 1) {
    return NextResponse.json({
      error: `Se esperaba exactamente 1 tenant con casino_deposit_enabled='true'; hay ${enabled?.length ?? 0}. Abortado por seguridad.`,
    }, { status: 409 });
  }
  const tenantId = enabled[0].tenant_id as string;

  // Nombre del tenant (para el label) + settings casino_* del tenant.
  const { data: tenant } = await supabaseAdmin
    .from('tenants').select('name').eq('id', tenantId).maybeSingle();
  const { data: cfgRows, error: cfgErr } = await supabaseAdmin
    .from('settings').select('key, value').eq('tenant_id', tenantId).in('key', CASINO_KEYS as unknown as string[]);
  if (cfgErr) return NextResponse.json({ error: cfgErr.message }, { status: 500 });
  const cfg = new Map<string, string>((cfgRows ?? []).map((r: any) => [r.key, String(r.value ?? '')]));

  // Credenciales de API: env, con los MISMOS defaults que client.ts (para 17Star
  // esos defaults ya son los correctos).
  const agent_username = process.env.CASINO_AGENT_USERNAME ?? 'gonza0106';
  const agent_id       = process.env.CASINO_AGENT_ID ?? 'cmoj1nya83zdnmhqizvk1hpbt';
  const skin_id        = process.env.CASINO_SKIN_ID ?? 'eeafa00307a1';

  const api_base_url = (cfg.get('casino_api_base_url') ?? '').trim() || (process.env.CASINO_API_BASE_URL ?? '').trim();
  if (!api_base_url) {
    return NextResponse.json({ error: 'El tenant no tiene casino_api_base_url; no se puede derivar el dominio del casino' }, { status: 409 });
  }

  // skin_domain = host de la URL del panel (destino del proxy). Ej:
  // https://admin.celuapuestas.bond/ → admin.celuapuestas.bond
  let skin_domain: string;
  try {
    skin_domain = new URL(api_base_url).host;
  } catch {
    return NextResponse.json({ error: `casino_api_base_url no es una URL válida: ${api_base_url}` }, { status: 409 });
  }

  const player_url   = (cfg.get('casino_player_url') ?? '').trim() || null;
  const player_url_2 = (cfg.get('casino_player_url_2') ?? '').trim() || null;
  const template     = (cfg.get('casino_credentials_template') ?? '').trim() || null;
  const label        = tenant?.name ? `Casino ${tenant.name}` : 'Casino';

  const agent_password_enc = encryptSecret(password);

  const row = {
    tenant_id: tenantId,
    label,
    agent_username,
    agent_id,
    skin_id,
    skin_domain,
    api_base_url,
    player_url,
    player_url_2,
    credentials_template: template,
    agent_password_enc,
    connection_verified_at: null,   // se sella en el PR 4 con un "probar conexión" real
    active: true,
    is_default: true,
  };

  // Idempotente: buscar la fila default existente del tenant.
  const { data: existing } = await supabaseAdmin
    .from('casino_accounts').select('id')
    .eq('tenant_id', tenantId).eq('is_default', true).maybeSingle();

  let action: 'inserted' | 'updated';
  if (existing?.id) {
    const { error } = await supabaseAdmin.from('casino_accounts').update(row).eq('id', existing.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    action = 'updated';
  } else {
    const { error } = await supabaseAdmin.from('casino_accounts').insert(row);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    action = 'inserted';
  }

  // Resumen SIN secretos (nunca devolvemos el password ni el blob cifrado).
  return NextResponse.json({
    ok: true,
    action,
    tenant_id: tenantId,
    tenant_name: tenant?.name ?? null,
    label,
    agent_username,
    agent_id,
    skin_id,
    skin_domain,
    api_base_url,
    player_url,
    player_url_2,
    template_source: template ? 'custom' : 'default',
    password_encrypted: true,
    connection_verified_at: null,
  });
}
