import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { requireAdmin } from '@/lib/current-agent';
import { isSecretEncryptionConfigured } from '@/lib/secure-secret';
import { logActivity, ACTIVITY } from '@/lib/activity-log';
import { DEFAULT_CASINO_CREDENTIALS_TEMPLATE } from '@/lib/casino/credentials';
import { getProvider, providerCatalog } from '@/lib/casino/providers';
import {
  buildProviderPatch, contextFromRow, loadProviderAccount, providerIdOf, publicProviderState,
} from '@/lib/casino/provider-account';

// /api/tenants/[id]/casino — configuración de casino de CUALQUIER tenant, desde la
// pantalla de admin (Admin → Tenants → Casino). Genérico: sirve para todos los
// proveedores del registro (lib/casino/providers) y arma el formulario con sus campos.
//
// Guard: requireAdmin (admin global). El scope es SIEMPRE el tenant del path; nada
// se lee ni se escribe de otro tenant.
//
// Secretos: se reciben, se cifran (secrets_enc / columna propia) y NUNCA vuelven: el
// GET solo dice si cada secreto está cargado. No se loguean.
//
// GET  → { providers, account, enabled }
// POST → { action: 'save' | 'set_enabled' | 'test', ... }
//   save        { provider, values, player_url?, player_url_2?, credentials_template?, confirm_provider_change? }
//               Si cambia algo de la conexión, PRIMERO se prueba con los datos nuevos y
//               solo si pasa se guarda (y queda verificado). Una prueba fallida no
//               persiste nada: la conexión anterior sigue intacta. Al cambiar la
//               conexión, el casino se apaga hasta que el admin lo vuelva a activar.
//   set_enabled { enabled } — activar exige una conexión verificada.
//   test        re-prueba la conexión guardada y sella connection_verified_at.

const FLAG_KEY = 'casino_deposit_enabled';

type Params = { params: Promise<{ id: string }> };

async function loadDefaultRow(tenantId: string) {
  const { data, error } = await supabaseAdmin
    .from('casino_accounts').select('*')
    .eq('tenant_id', tenantId).eq('is_default', true).maybeSingle();
  return { row: data ?? null, error: error?.message ?? null };
}

async function getFlag(tenantId: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from('settings').select('value').eq('key', FLAG_KEY).eq('tenant_id', tenantId).maybeSingle();
  return data?.value === 'true';
}

function setFlag(tenantId: string, on: boolean) {
  return supabaseAdmin.from('settings')
    .upsert({ key: FLAG_KEY, value: on ? 'true' : 'false', tenant_id: tenantId }, { onConflict: 'key,tenant_id' });
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

async function state(tenantId: string) {
  const [{ row }, enabled] = await Promise.all([loadDefaultRow(tenantId), getFlag(tenantId)]);
  return {
    providers: providerCatalog(),
    enabled,
    default_template: DEFAULT_CASINO_CREDENTIALS_TEMPLATE,
    account: {
      ...publicProviderState(row),
      label: row?.label ?? null,
      active: row?.active ?? false,
      connection_verified_at: row?.connection_verified_at ?? null,
      player_url: row?.player_url ?? '',
      player_url_2: row?.player_url_2 ?? '',
      credentials_template: row?.credentials_template ?? '',
    },
  };
}

async function tenantExists(tenantId: string): Promise<{ name: string } | null> {
  const { data } = await supabaseAdmin.from('tenants').select('name').eq('id', tenantId).maybeSingle();
  return data ? { name: String(data.name ?? '') } : null;
}

export async function GET(_req: Request, { params }: Params) {
  if (!(await requireAdmin())) return new NextResponse('Requiere rol admin', { status: 403 });
  const { id: tenantId } = await params;
  if (!(await tenantExists(tenantId))) return new NextResponse('Tenant no encontrado', { status: 404 });
  return NextResponse.json(await state(tenantId));
}

export async function POST(request: Request, { params }: Params) {
  const session = await requireAdmin();
  if (!session) return new NextResponse('Requiere rol admin', { status: 403 });
  const { id: tenantId } = await params;
  const tenant = await tenantExists(tenantId);
  if (!tenant) return new NextResponse('Tenant no encontrado', { status: 404 });

  const body = await request.json().catch(() => ({} as any));
  const action = body?.action;
  const log = (details: Record<string, unknown>) => logActivity({
    tenantId, actor: { id: session.sub, name: session.name, role: session.role },
    action: ACTIVITY.CONFIG_CHANGED, objectType: 'config', objectId: 'casino_account', details,
  });

  // ── Guardar (con prueba previa si cambia la conexión) ────────────────────────
  if (action === 'save') {
    if (!isSecretEncryptionConfigured()) {
      return NextResponse.json({ error: 'Falta la clave de cifrado (SECRET_ENC_KEY) en el entorno' }, { status: 500 });
    }
    const provider = getProvider(body.provider);
    if (!provider) return NextResponse.json({ error: 'Proveedor de casino desconocido' }, { status: 400 });

    const { row: existing, error: readErr } = await loadDefaultRow(tenantId);
    if (readErr) return NextResponse.json({ error: readErr }, { status: 500 });
    const providerChange = !!existing && providerIdOf(existing) !== provider.id;
    if (providerChange && body.confirm_provider_change !== true) {
      return NextResponse.json({
        error: `Este tenant usa ${getProvider(providerIdOf(existing))?.label ?? providerIdOf(existing)}. ` +
          'Cambiar de proveedor borra la conexión anterior y apaga el casino. Confirmá el cambio.',
        needs_confirmation: true,
      }, { status: 409 });
    }

    const values = (body.values && typeof body.values === 'object') ? body.values : {};
    const { patch, connChanged, missing } = buildProviderPatch(provider, existing, { values });
    if (missing.length) return NextResponse.json({ error: `Faltan datos: ${missing.join(', ')}` }, { status: 400 });

    for (const k of ['player_url', 'player_url_2', 'credentials_template'] as const) {
      if (typeof body[k] === 'string') patch[k] = k === 'credentials_template' ? (body[k].trim() ? body[k] : null) : str(body[k]);
    }

    if (connChanged) {
      // Probar con los datos NUEVOS antes de persistir. Nada se escribe si falla.
      const probeRow = { ...(existing ?? {}), ...patch, id: existing?.id ?? '', tenant_id: tenantId };
      let result;
      try {
        result = await provider.testConnection(contextFromRow(provider, probeRow));
      } catch (err: any) {
        console.error(`[admin/casino] prueba previa falló tenant=${tenantId} provider=${provider.id}:`, err?.message ?? err);
        result = { ok: false as const, error: 'No se pudo probar la conexión.' };
      }
      if (!result.ok) {
        await log({ action: 'save_rejected', provider: provider.id, reason: 'test_failed' });
        return NextResponse.json({ error: `No se guardó: ${result.error}`, saved: false }, { status: 400 });
      }
      patch.connection_verified_at = new Date().toISOString();
    }

    let writeErr: { message: string } | null = null;
    if (existing) {
      ({ error: writeErr } = await supabaseAdmin.from('casino_accounts').update(patch).eq('id', existing.id).eq('tenant_id', tenantId));
    } else {
      const nm = tenant.name.trim();
      ({ error: writeErr } = await supabaseAdmin.from('casino_accounts').insert({
        ...patch, tenant_id: tenantId, active: true, is_default: true,
        label: !nm ? 'Casino' : /^casino\b/i.test(nm) ? nm : `Casino ${nm}`,
      }));
    }
    if (writeErr) return NextResponse.json({ error: writeErr.message }, { status: 500 });

    // Fail-safe: conexión nueva → casino apagado hasta que el admin lo active.
    if (connChanged) await setFlag(tenantId, false);
    await log({ action: 'save', provider: provider.id, conn_changed: connChanged, provider_changed: providerChange });
    return NextResponse.json({ ok: true, tested: connChanged, ...(await state(tenantId)) });
  }

  // ── Activar / desactivar ────────────────────────────────────────────────────
  if (action === 'set_enabled') {
    const on = body.enabled === true;
    if (on) {
      const load = await loadProviderAccount(tenantId);
      if (load.kind !== 'ok') {
        return NextResponse.json({ error: load.kind === 'none' ? 'El tenant no tiene casino configurado' : load.error }, { status: 400 });
      }
      if (!load.row.connection_verified_at) {
        return NextResponse.json({ error: 'Probá la conexión antes de activar el casino' }, { status: 400 });
      }
    }
    const { error } = await setFlag(tenantId, on);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    await log({ action: 'set_enabled', enabled: on });
    return NextResponse.json({ ok: true, ...(await state(tenantId)) });
  }

  // ── Re-probar la conexión guardada ──────────────────────────────────────────
  if (action === 'test') {
    const load = await loadProviderAccount(tenantId);
    if (load.kind === 'none') return NextResponse.json({ ok: false, error: 'El tenant no tiene casino configurado' }, { status: 404 });
    if (load.kind === 'broken') return NextResponse.json({ ok: false, error: load.error }, { status: 400 });
    const result = await load.provider.testConnection(load.ctx);
    if (result.ok) {
      await supabaseAdmin.from('casino_accounts')
        .update({ connection_verified_at: new Date().toISOString() })
        .eq('id', load.ctx.accountId).eq('tenant_id', tenantId);
    }
    await log({ action: 'test', provider: load.provider.id, ok: result.ok, reason: result.ok ? null : result.reason });
    return NextResponse.json(result.ok
      ? { ok: true, message: result.message, ...(await state(tenantId)) }
      : { ok: false, error: result.error });
  }

  return NextResponse.json({ error: 'Acción inválida' }, { status: 400 });
}
