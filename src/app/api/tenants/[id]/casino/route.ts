import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { requireAdmin } from '@/lib/current-agent';
import { isSecretEncryptionConfigured } from '@/lib/secure-secret';
import { logActivity, ACTIVITY } from '@/lib/activity-log';
import { DEFAULT_CASINO_CREDENTIALS_TEMPLATE } from '@/lib/casino/credentials';
import { getProvider, providerCatalog } from '@/lib/casino/providers';
import {
  AGENT_BALANCE_VERIFIED_KEY, buildProviderPatch, contextFromRow, loadProviderAccount, providerIdOf, publicProviderState,
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
//   Campos scope 'agent_balance' (saldo del agente, opcionales): cambiarlos corre
//   provider.testAgentBalance con lo tipeado; si falla no se guarda. NO apagan el
//   casino (no tocan depósitos ni altas) y borran la sesión cacheada de la cuenta.
//   save acepta `clear: [keys]` para borrar secretos opcionales; si faltan los datos
//   del saldo, se saca la marca y el tenant vuelve a 'hybrid'.
//   agent_balance_preview  saldo real + pozo (solo lectura).
//   set_agent_balance { on } activa/desactiva el saldo del agente (modo casino/hybrid);
//                       activar exige una prueba con login nuevo. Queda en el log el
//                       pozo y el saldo real del momento.

// La prueba previa puede encadenar la API y el login al panel del proveedor.
export const maxDuration = 60;

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

/** Pozo de fichas del tenant (fichas_stock), para el registro del cambio de modo. */
async function readPozo(tenantId: string): Promise<number | null> {
  const { data, error } = await supabaseAdmin.from('fichas_stock').select('stock_actual').eq('tenant_id', tenantId).maybeSingle();
  if (error || !data) return null;
  const n = Number(data.stock_actual);
  return Number.isFinite(n) ? n : null;
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
      agent_balance_verified_at: (row?.config && typeof row.config === 'object' && typeof row.config[AGENT_BALANCE_VERIFIED_KEY] === 'string')
        ? row.config[AGENT_BALANCE_VERIFIED_KEY] : null,
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
    const clear = Array.isArray(body.clear) ? body.clear : [];
    const { patch, connChanged, balanceChanged, agentBalanceTurnedOff, missing } = buildProviderPatch(provider, existing, { values, clear });
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

    // Datos del saldo del agente (scope 'agent_balance', p. ej. el panel de
    // agentes.plus): prueba propia con lo tipeado antes de persistir. Si quedaron
    // vacíos no hay nada que probar. NO apaga el casino: no tocan depósitos ni altas.
    let balanceTested = false;
    if (balanceChanged && provider.testAgentBalance) {
      let ctx;
      try {
        ctx = contextFromRow(provider, { ...(existing ?? {}), ...patch, id: existing?.id ?? '', tenant_id: tenantId });
      } catch {
        ctx = null;
      }
      // Solo cuentan los datos propios (usuario, contraseña): los campos con valor por
      // defecto (URL, salida) "están" siempre y no dicen que haya algo para probar.
      const hasAny = !!ctx && provider.fields.some((f) => f.scope === 'agent_balance' && !f.defaultValue &&
        (f.kind === 'secret' ? !!ctx!.secrets[f.key] : !!ctx!.values[f.key]));
      if (hasAny) {
        balanceTested = true;
        const r = ctx ? await provider.testAgentBalance(ctx) : { ok: false as const, error: 'No se pudo leer la configuración.' };
        if (!r.ok) {
          await log({ action: 'save_rejected', provider: provider.id, reason: 'agent_balance_test_failed' });
          return NextResponse.json({ error: `No se guardó: ${r.error}`, saved: false }, { status: 400 });
        }
      }
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
    // Datos del saldo cambiados: la sesión guardada era de los anteriores.
    if (balanceChanged && existing?.id) {
      const { error: delErr } = await supabaseAdmin.from('casino_sessions').delete().eq('account_id', existing.id);
      if (delErr) console.warn(`[admin/casino] no se pudo borrar la sesión vieja tenant=${tenantId}:`, delErr.message);
    }
    await log({ action: 'save', provider: provider.id, conn_changed: connChanged, balance_changed: balanceChanged, provider_changed: providerChange });
    // Se borraron datos del saldo que estaba activado: el tenant volvió a 'hybrid' y el
    // pozo vuelve a usarse con el valor que tenía congelado.
    if (agentBalanceTurnedOff) {
      await log({ action: 'agent_balance_off', provider: provider.id, motivo: 'datos del panel borrados', pozo_actual: await readPozo(tenantId) });
    }
    return NextResponse.json({
      ok: true,
      conn_changed: connChanged,
      balance_tested: balanceTested,
      agent_balance_off: agentBalanceTurnedOff,
      ...(await state(tenantId)),
    });
  }

  // ── Saldo del agente (proveedores con saldo opcional, p. ej. agentes.plus) ────
  // preview: saldo real + pozo, para mostrar antes de cambiar. set_agent_balance:
  // { on } activa (prueba con login nuevo y pone la marca → 'casino') o desactiva
  // (saca la marca → 'hybrid'). Las dos dejan en el log el pozo y el saldo real.
  if (action === 'agent_balance_preview' || action === 'set_agent_balance') {
    const load = await loadProviderAccount(tenantId);
    if (load.kind === 'none') return NextResponse.json({ ok: false, error: 'El tenant no tiene casino configurado' }, { status: 404 });
    if (load.kind === 'broken') return NextResponse.json({ ok: false, error: load.error }, { status: 400 });
    const { provider, ctx, row } = load;
    if (!provider.optionalAgentBalance || !provider.testAgentBalance) {
      return NextResponse.json({ ok: false, error: `${provider.label} no tiene saldo del agente opcional.` }, { status: 400 });
    }
    const config: Record<string, unknown> = (row.config && typeof row.config === 'object') ? { ...row.config } : {};
    const isOn = !!config[AGENT_BALANCE_VERIFIED_KEY];
    const pozo = await readPozo(tenantId);

    if (action === 'agent_balance_preview') {
      if (!provider.readAgentBalanceDetail) return NextResponse.json({ ok: false, error: 'El proveedor no lee el saldo del agente' }, { status: 400 });
      const r = await provider.readAgentBalanceDetail(ctx);
      if (!r.ok) return NextResponse.json({ ok: false, error: r.error });
      return NextResponse.json({ ok: true, on: isOn, saldo: r.balance, pozo, diferencia: pozo === null ? null : r.balance - pozo });
    }

    const on = body.on === true;
    if (on === isOn) return NextResponse.json({ ok: true, unchanged: true, ...(await state(tenantId)) });

    let saldo: number | null = null;
    if (on) {
      // Prueba con login NUEVO, igual que al guardar: solo se activa si anda hoy.
      const t = await provider.testAgentBalance(ctx);
      if (!t.ok) return NextResponse.json({ ok: false, error: `No se activó: ${t.error}` }, { status: 400 });
      saldo = typeof t.balance === 'number' ? t.balance : null;
      config[AGENT_BALANCE_VERIFIED_KEY] = new Date().toISOString();
    } else {
      delete config[AGENT_BALANCE_VERIFIED_KEY];
    }
    const { error: upErr } = await supabaseAdmin.from('casino_accounts')
      .update({ config }).eq('id', row.id).eq('tenant_id', tenantId);
    if (upErr) return NextResponse.json({ ok: false, error: upErr.message }, { status: 500 });

    await log(on
      ? {
          action: 'agent_balance_on', provider: provider.id,
          pozo_congelado: pozo, saldo_real: saldo, diferencia: saldo !== null && pozo !== null ? saldo - pozo : null,
        }
      : { action: 'agent_balance_off', provider: provider.id, motivo: 'desactivado por el admin', pozo_actual: pozo });
    return NextResponse.json({
      ok: true, on, pozo, saldo, diferencia: saldo !== null && pozo !== null ? saldo - pozo : null,
      ...(await state(tenantId)),
    });
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
