import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { requireAgentOrAdmin } from '@/lib/current-agent';
import { encryptSecret, isSecretEncryptionConfigured } from '@/lib/secure-secret';
import { DEFAULT_CASINO_CREDENTIALS_TEMPLATE } from '@/lib/casino/credentials';
import { logActivity, ACTIVITY } from '@/lib/activity-log';

// GET/POST /api/casino/account — Etapa 2, PR 5. Config self-service de la conexión
// de casino del tenant. Las CREDENCIALES viven en casino_accounts (cifradas); el
// FLAG on/off sigue en settings.casino_deposit_enabled (lo leen caja/comprobantes/
// balance/create-player + una función SQL). Guard: agent o admin, acotado al tenant
// de la sesión (un admin también puede configurarle el casino a un cliente).
//
// Gate de 3 capas para prender depósitos:
//   1) UI: switch bloqueado sin verificación (front).
//   2) server-reject: enabled=true con connection_verified_at=null → 400 (acá).
//   3) fail-safe: si cambia una credencial de conexión, se limpia
//      connection_verified_at y se apaga el flag (acá).

const FLAG_KEY = 'casino_deposit_enabled';

// api_base_url ("https://admin.x.bond/") → host ("admin.x.bond"), destino del proxy.
function deriveHost(apiBaseUrl: string): string | null {
  const s = apiBaseUrl.trim();
  if (!s) return null;
  try { return new URL(s).host; }
  catch { return s.replace(/^https?:\/\//, '').replace(/\/.*$/, '') || null; }
}

// Label sin duplicar "Casino" cuando el tenant ya se llama "Casino X".
function deriveLabel(name: string): string {
  const nm = name.trim();
  if (!nm) return 'Casino';
  return /^casino\b/i.test(nm) ? nm : `Casino ${nm}`;
}

async function loadRow(tenantId: string) {
  const { data } = await supabaseAdmin
    .from('casino_accounts')
    .select('id, label, agent_username, agent_id, skin_id, skin_domain, api_base_url, player_url, player_url_2, credentials_template, agent_password_enc, connection_verified_at, active, is_default')
    .eq('tenant_id', tenantId).eq('is_default', true).maybeSingle();
  return data ?? null;
}

async function getFlag(tenantId: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from('settings').select('value').eq('key', FLAG_KEY).eq('tenant_id', tenantId).maybeSingle();
  return data?.value === 'true';
}

async function setFlag(tenantId: string, on: boolean) {
  return supabaseAdmin.from('settings')
    .upsert({ key: FLAG_KEY, value: on ? 'true' : 'false', tenant_id: tenantId }, { onConflict: 'key,tenant_id' });
}

// Estado público (SIN secretos: nunca devolvemos el blob cifrado ni el password).
function publicState(row: any, enabled: boolean) {
  return {
    enabled,
    has_row: !!row,
    label: row?.label ?? null,
    agent_username: row?.agent_username ?? '',
    agent_id: row?.agent_id ?? '',
    skin_id: row?.skin_id ?? '',
    api_base_url: row?.api_base_url ?? '',
    player_url: row?.player_url ?? '',
    player_url_2: row?.player_url_2 ?? '',
    credentials_template: (row?.credentials_template && String(row.credentials_template).trim())
      ? row.credentials_template : DEFAULT_CASINO_CREDENTIALS_TEMPLATE,
    has_password: !!row?.agent_password_enc,
    connection_verified_at: row?.connection_verified_at ?? null,
  };
}

export async function GET() {
  const session = await requireAgentOrAdmin();
  if (!session) return new NextResponse('Requiere rol admin o agent', { status: 403 });
  const tid = session.tenant_id;
  const [row, enabled] = await Promise.all([loadRow(tid), getFlag(tid)]);
  return NextResponse.json(publicState(row, enabled));
}

export async function POST(request: Request) {
  const session = await requireAgentOrAdmin();
  if (!session) return new NextResponse('Requiere rol admin o agent', { status: 403 });
  const tid = session.tenant_id;
  const body = await request.json().catch(() => ({} as any));

  const existing = await loadRow(tid);

  // ── Rama A: guardado de credenciales/URLs/template (form completo) ────────────
  // Se detecta por la presencia de agent_username (el switch solo manda { enabled }).
  const isCredSave = typeof body.agent_username === 'string';
  if (isCredSave) {
    if (!isSecretEncryptionConfigured()) {
      return NextResponse.json({ error: 'Falta la clave de cifrado (SECRET_ENC_KEY) en el entorno' }, { status: 500 });
    }
    const agent_username = String(body.agent_username ?? '').trim();
    const agent_id       = String(body.agent_id ?? '').trim();
    const skin_id        = String(body.skin_id ?? '').trim();
    const api_base_url   = String(body.api_base_url ?? '').trim();
    const skin_domain    = api_base_url ? deriveHost(api_base_url) : null;
    const newPassword    = typeof body.agent_password === 'string' ? body.agent_password.trim() : '';

    const missing = [
      !agent_username && 'usuario', !agent_id && 'ID de agente', !skin_id && 'skin',
      !skin_domain && 'dominio del casino',
    ].filter(Boolean);
    if (missing.length) return NextResponse.json({ error: `Faltan datos: ${missing.join(', ')}` }, { status: 400 });
    if (!existing && !newPassword) {
      return NextResponse.json({ error: 'Falta la contraseña/token del agente' }, { status: 400 });
    }

    // ¿Cambió alguna credencial de CONEXIÓN? (URLs/template NO cuentan.) Un password
    // nuevo siempre cuenta como cambio (no comparamos ciphertext).
    const connChanged =
      !existing ||
      existing.agent_username !== agent_username ||
      existing.agent_id !== agent_id ||
      existing.skin_id !== skin_id ||
      (existing.skin_domain ?? '') !== (skin_domain ?? '') ||
      !!newPassword;

    const row: any = {
      tenant_id: tid,
      agent_username, agent_id, skin_id, skin_domain, api_base_url,
      player_url:   typeof body.player_url === 'string' ? (body.player_url.trim() || null) : (existing?.player_url ?? null),
      player_url_2: typeof body.player_url_2 === 'string' ? (body.player_url_2.trim() || null) : (existing?.player_url_2 ?? null),
      credentials_template: typeof body.credentials_template === 'string'
        ? (body.credentials_template.trim() ? body.credentials_template : null)
        : (existing?.credentials_template ?? null),
      active: true,
      is_default: true,
    };
    if (newPassword) row.agent_password_enc = encryptSecret(newPassword);
    if (connChanged) row.connection_verified_at = null;   // fail-safe: hay que re-probar
    if (!existing) {
      const { data: t } = await supabaseAdmin.from('tenants').select('name').eq('id', tid).maybeSingle();
      row.label = deriveLabel(String(t?.name ?? ''));
    }

    let writeErr: { message: string } | null = null;
    if (existing) {
      ({ error: writeErr } = await supabaseAdmin.from('casino_accounts').update(row).eq('id', existing.id));
    } else {
      ({ error: writeErr } = await supabaseAdmin.from('casino_accounts').insert(row));
    }
    if (writeErr) return NextResponse.json({ error: writeErr.message }, { status: 500 });

    // fail-safe: credencial cambiada → apagar depósitos hasta re-verificar.
    if (connChanged) await setFlag(tid, false);

    await logActivity({
      session, action: ACTIVITY.CONFIG_CHANGED, objectType: 'config', objectId: 'casino_account',
      details: { conn_changed: connChanged, password_changed: !!newPassword },
    });
  }

  // ── Rama B: toggle del flag (switch, o si viniera junto con el save) ──────────
  if (typeof body.enabled === 'boolean') {
    const rowNow = await loadRow(tid);   // re-leer: la rama A pudo limpiar verified
    if (body.enabled && !rowNow?.connection_verified_at) {
      return NextResponse.json({ error: 'Probá la conexión antes de activar los depósitos' }, { status: 400 });
    }
    const { error } = await setFlag(tid, body.enabled);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const [row, enabled] = await Promise.all([loadRow(tid), getFlag(tid)]);
  return NextResponse.json({ ok: true, ...publicState(row, enabled) });
}
