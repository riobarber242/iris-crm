import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/current-agent';
import { logActivity, ACTIVITY } from '@/lib/activity-log';
import { loadProviderAccount } from '@/lib/casino/provider-account';
import {
  AMBIGUOUS_CREATE_MSG, CREATE_CONFIRM_RESERVE_MS, CREATE_FLOW_BUDGET_MS, confirmPlayerCreated,
} from '@/lib/casino/provider-create-player';

// POST /api/tenants/[id]/casino/tools — herramientas de PRUEBA del admin global sobre
// la conexión de casino de un tenant. Existen para probar un proveedor nuevo sin
// activar el casino (el flag queda apagado y ningún comprobante real deposita).
//
//   { action: 'player_balance', username }
//   { action: 'create_player',  username, password }
//   { action: 'deposit',        username, amount }   ← tope MAX_TEST_DEPOSIT
//   { action: 'probe_create' }  ← create_player con datos vacíos: mide el endpoint, no crea
//   { action: 'probe_agent_balance' } ← acciones de lectura candidatas al saldo del agente
//   { action: 'read_agent_balance' }  ← saldo del agente por el camino real (sesión
//                                       guardada; dice si tuvo que volver a loguearse)
//
// Solo proveedores del modelo nuevo (celuapuestas opera por su propio código). No toca
// contactos ni comprobantes. Guard: requireAdmin, scope = tenant del path.
// El depósito de prueba NO se reintenta (salvo 429, en el adaptador) y muestra el saldo
// antes y después; si queda ambiguo lo dice, para mirarlo en el panel del casino.

export const maxDuration = 60;

const MAX_TEST_DEPOSIT = 100;
// Un depósito de prueba por tenant a la vez (por instancia): corta el doble click.
const depositInProgress = new Set<string>();

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  const session = await requireAdmin();
  if (!session) return new NextResponse('Requiere rol admin', { status: 403 });
  const { id: tenantId } = await params;

  const body = await request.json().catch(() => ({} as any));
  const action = body?.action;
  const username = typeof body?.username === 'string' ? body.username.trim().toLowerCase() : '';
  if (!username && action !== 'probe_create' && action !== 'probe_agent_balance' && action !== 'read_agent_balance') {
    return NextResponse.json({ ok: false, error: 'Falta el usuario del jugador' }, { status: 400 });
  }

  const load = await loadProviderAccount(tenantId);
  if (load.kind === 'none') return NextResponse.json({ ok: false, error: 'El tenant no tiene casino configurado' }, { status: 404 });
  if (load.kind === 'broken') return NextResponse.json({ ok: false, error: load.error }, { status: 400 });
  const { provider, ctx } = load;
  if (provider.legacyOperations) {
    return NextResponse.json({ ok: false, error: `Las herramientas de prueba no aplican a ${provider.label}.` }, { status: 400 });
  }

  const log = (details: Record<string, unknown>) => logActivity({
    tenantId, actor: { id: session.sub, name: session.name, role: session.role },
    action: ACTIVITY.CASINO_DEPOSIT, objectType: 'casino_test', objectId: provider.id,
    details: { test_tool: action, username, ...details },
  });

  if (action === 'player_balance') {
    if (!provider.playerBalance) return NextResponse.json({ ok: false, error: 'El proveedor no expone el saldo del jugador' }, { status: 400 });
    const r = await provider.playerBalance(ctx, username);
    return NextResponse.json(r.ok ? { ok: true, balance: r.balance } : { ok: false, error: r.error });
  }

  // Diagnóstico del endpoint de alta SIN crear a nadie: create_player con usuario y
  // contraseña VACÍOS (sin usuario no hay jugador posible). Dice si el endpoint
  // contesta rápido (y qué) o si se cuelga también con datos inválidos.
  if (action === 'probe_create') {
    if (!provider.createPlayer) return NextResponse.json({ ok: false, error: 'El proveedor no permite crear usuarios' }, { status: 400 });
    const t0 = Date.now();
    const r = await provider.createPlayer(ctx, '', '', { deadlineAt: Date.now() + CREATE_FLOW_BUDGET_MS });
    const ms = Date.now() - t0;
    await log({ probe: true, ms, ok: r.ok, reason: r.ok ? null : r.reason, detail: r.ok ? null : r.detail });
    return NextResponse.json({
      ok: true, probe: true, ms,
      answered: r.ok || !r.ambiguous,
      result: r.ok ? 'el proveedor aceptó el pedido vacío (inesperado)' : `${r.reason}: ${r.error}`,
      detail: r.ok ? null : r.detail,
    });
  }

  // Búsqueda del saldo del agente: acciones de SOLO LECTURA de una lista fija que
  // vive en el adaptador (el body de este pedido no elige ninguna acción).
  if (action === 'probe_agent_balance') {
    if (!provider.probeAgentBalance) return NextResponse.json({ ok: false, error: 'El proveedor no tiene esta prueba' }, { status: 400 });
    const results = await provider.probeAgentBalance(ctx);
    await log({ probe_agent_balance: results.map((r) => ({ action: r.action, http: r.httpStatus, ms: r.ms })) });
    return NextResponse.json({ ok: true, results });
  }

  // Saldo del agente por el mismo camino que va a usar el chip (cache de sesión
  // incluido). Sirve para ver si una sesión abierta en otro lado invalidó la de IRIS.
  if (action === 'read_agent_balance') {
    if (!provider.readAgentBalanceDetail) return NextResponse.json({ ok: false, error: 'El proveedor no lee el saldo del agente' }, { status: 400 });
    const r = await provider.readAgentBalanceDetail(ctx);
    await log(r.ok ? { ok: true, reused_session: r.reusedSession, ms: r.ms } : { ok: false, reason: r.reason, ms: r.ms });
    return NextResponse.json(r.ok
      ? { ok: true, balance: r.balance, raw: r.raw, reused_session: r.reusedSession, ms: r.ms }
      : { ok: false, error: r.error, ms: r.ms });
  }

  if (action === 'create_player') {
    if (!provider.createPlayer) return NextResponse.json({ ok: false, error: 'El proveedor no permite crear usuarios' }, { status: 400 });
    const password = typeof body?.password === 'string' && body.password.trim() ? body.password.trim() : provider.password.generate();
    if (!provider.password.rule.test(password)) return NextResponse.json({ ok: false, error: provider.password.ruleText }, { status: 400 });
    // Mismo presupuesto que el alta del operador: el alta tarda y se reserva la cola
    // para confirmar por saldo si quedó ambigua.
    const deadlineAt = Date.now() + CREATE_FLOW_BUDGET_MS;
    const r = await provider.createPlayer(ctx, username, password, { deadlineAt: deadlineAt - CREATE_CONFIRM_RESERVE_MS });
    const confirmed = !r.ok && r.ambiguous && await confirmPlayerCreated(provider, ctx, username, deadlineAt);
    await log({ ok: r.ok || confirmed, confirmed_by_balance: confirmed, reason: r.ok ? null : r.reason, detail: r.ok ? null : r.detail });
    if (r.ok || confirmed) {
      return NextResponse.json({ ok: true, username, password, confirmed_by_balance: confirmed });
    }
    // En un alta ambigua se devuelve la contraseña igual: si el usuario aparece más
    // tarde en el panel, es la que quedó.
    return NextResponse.json({
      ok: false, ambiguous: r.ambiguous, taken: r.taken,
      error: r.ambiguous ? `${r.error} ${AMBIGUOUS_CREATE_MSG}` : r.error,
      ...(r.ambiguous ? { username, password } : {}),
    });
  }

  if (action === 'deposit') {
    if (!provider.deposit || !provider.playerBalance) {
      return NextResponse.json({ ok: false, error: 'El proveedor no soporta depósitos' }, { status: 400 });
    }
    const amount = Number(body?.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_TEST_DEPOSIT) {
      return NextResponse.json({ ok: false, error: `El depósito de prueba tiene que ser mayor a 0 y hasta ${MAX_TEST_DEPOSIT}` }, { status: 400 });
    }
    if (depositInProgress.has(tenantId)) {
      return NextResponse.json({ ok: false, error: 'Ya hay un depósito de prueba en curso para este tenant' }, { status: 409 });
    }
    depositInProgress.add(tenantId);
    try {
      const before = await provider.playerBalance(ctx, username);
      if (!before.ok) return NextResponse.json({ ok: false, error: `${before.error} No se depositó nada.` });

      const r = await provider.deposit(ctx, username, amount, Date.now() + 25_000);
      if (r.kind === 'not_applied') {
        await log({ amount, result: 'not_applied', reason: r.reason, b0: before.balance });
        return NextResponse.json({ ok: false, error: `${r.error} No se depositó nada.`, balance_before: before.balance });
      }
      if (r.kind === 'ambiguous') await new Promise((res) => setTimeout(res, 3_000));
      const after = await provider.playerBalance(ctx, username, { retry: false });
      const b1 = after.ok ? after.balance : null;
      const result = r.kind === 'ok' ? 'ok' : 'ambiguous';
      await log({ amount, result, b0: before.balance, b1 });
      return NextResponse.json({
        ok: r.kind === 'ok',
        ambiguous: r.kind === 'ambiguous',
        error: r.kind === 'ambiguous'
          ? `${r.error} No se sabe si entró: revisá el panel del casino antes de repetir la prueba.`
          : undefined,
        balance_before: before.balance,
        balance_after: b1,
      });
    } finally {
      depositInProgress.delete(tenantId);
    }
  }

  return NextResponse.json({ ok: false, error: 'Acción inválida' }, { status: 400 });
}
