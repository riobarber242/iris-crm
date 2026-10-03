// Prueba OFFLINE (sin red ni base) de la protección de doble depósito para
// celuapuestas (17Star): clasificación del DoDeposit, bloqueo del camino de siempre,
// interruptor por tenant, y el flujo deposit-guard + verify-carga con una base falsa
// en memoria (doble click, ambiguo reconciliado, ambiguo a revisar, rechazado, y
// "primero el casino, después la caja").
// Uso:  npx tsx scripts/verify-celuapuestas-guard.ts
import { classifyDeposit } from '../src/lib/casino/providers/celuapuestas';
import {
  STALE_MS, UNKNOWN_DEPOSIT_MSG, guardedDeposit, isDepositGuardEnabled, legacyDepositBlock,
} from '../src/lib/casino/deposit-guard';
import { verifyCargaWithProvider, type VerifyCargaDeps } from '../src/lib/casino/verify-carga';
import type { CasinoProvider, ProviderContext, ProviderWriteResult } from '../src/lib/casino/providers/types';

let fails = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? 'OK  ' : 'FALLA'} ${name} → ${JSON.stringify(got)}${ok ? '' : `  (esperado ${JSON.stringify(want)})`}`);
};

// ── Base falsa: tablas en memoria con el subconjunto del query builder que se usa ──
type Row = Record<string, any>;
function fakeDb(tables: Record<string, Row[]>, opts: { failSettings?: boolean } = {}) {
  return {
    from(table: string) {
      const filters: ((r: Row) => boolean)[] = [];
      let patch: Row | null = null;
      let wantSelect = false;
      const rows = () => (tables[table] ??= []).filter((r) => filters.every((f) => f(r)));
      const run = () => {
        if (opts.failSettings && table === 'settings') return { data: null, error: { message: 'boom' } };
        if (patch) {
          const hit = rows();
          for (const r of hit) Object.assign(r, patch);
          return { data: wantSelect ? hit.map((r) => ({ id: r.id })) : null, error: null };
        }
        return { data: rows(), error: null };
      };
      const b: any = {
        update(p: Row) { patch = p; return b; },
        select() { wantSelect = true; return b; },
        eq(c: string, v: unknown) { filters.push((r) => r[c] === v); return b; },
        is(c: string, v: unknown) { filters.push((r) => (r[c] ?? null) === v); return b; },
        maybeSingle() { const r = run(); return Promise.resolve({ data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error }); },
        then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) { return Promise.resolve(run()).then(res, rej); },
      };
      return b;
    },
  } as any;
}

const T = 'tenant-17star';
const ctx: ProviderContext = { accountId: 'acc', tenantId: T, values: {}, secrets: {} };

/** Proveedor falso: saldo del jugador en memoria y un depósito programable. */
function fakeProvider(opts: { deposit: (amount: number) => ProviderWriteResult; balance?: number; creditOnAmbiguous?: boolean }) {
  let bal = opts.balance ?? 100;
  const calls = { deposit: 0, balance: 0 };
  const p: CasinoProvider = {
    id: 'celuapuestas', label: 'celuapuestas', fields: [], hasAgentBalance: true, legacyOperations: true,
    password: { rule: /./, ruleText: '', generate: () => 'x' },
    testConnection: async () => ({ ok: true, message: '' }),
    playerBalance: async () => { calls.balance++; return { ok: true, balance: bal }; },
    deposit: async (_c, _u, amount) => {
      calls.deposit++;
      await new Promise((r) => setTimeout(r, 5));
      const r = opts.deposit(amount);
      if (r.kind === 'ok' || (r.kind === 'ambiguous' && opts.creditOnAmbiguous)) bal += amount;
      return r;
    },
  };
  return { p, calls };
}
const comprobante = (id: string, extra: Row = {}): Row => ({
  id, tenant_id: T, casino_deposited_at: null, casino_deposit_state: null, casino_deposit_started_at: null, ...extra,
});

async function main() {
  console.log('— clasificación del DoDeposit de celuapuestas');
  eq('201', classifyDeposit({ result: { success: true } }).kind, 'ok');
  eq('timeout (AbortError)', classifyDeposit({ thrown: Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }) }), {
    kind: 'ambiguous', reason: 'timeout', error: 'El casino no respondió a tiempo al depositar.', detail: 'AbortError This operation was aborted',
  });
  eq('error de red', classifyDeposit({ thrown: new TypeError('fetch failed') }).kind, 'ambiguous');
  eq('502 del proxy sin JSON', classifyDeposit({ result: { success: false, detail: 'HTTP 502 - respuesta no JSON' } }).kind, 'ambiguous');
  eq('HTML (SPA) con 200', classifyDeposit({ result: { success: false, detail: 'HTTP 200 - respuesta no JSON' } }).kind, 'ambiguous');
  eq('401 del proxy sin JSON', classifyDeposit({ result: { success: false, detail: 'HTTP 401 - respuesta no JSON' } }).kind, 'not_applied');
  eq('403 del proxy sin JSON', classifyDeposit({ result: { success: false, detail: 'HTTP 403 - respuesta no JSON' } }).kind, 'not_applied');
  eq('error JSON del casino (sin saldo)', classifyDeposit({ result: { success: false, detail: 'Saldo insuficiente' } }), {
    kind: 'not_applied', reason: 'rejected', error: 'El casino rechazó el depósito: Saldo insuficiente.', detail: 'Saldo insuficiente',
  });

  console.log('— camino de siempre: bloqueo por estado');
  eq('sin estado', legacyDepositBlock({}), null);
  eq('ya acreditada', legacyDepositBlock({ casino_deposited_at: 'x', casino_deposit_state: 'done' }), null);
  eq('a revisar', legacyDepositBlock({ casino_deposit_state: 'unknown' }), UNKNOWN_DEPOSIT_MSG);
  eq('en curso', legacyDepositBlock({ casino_deposit_state: 'in_flight', casino_deposit_started_at: new Date().toISOString() }),
    'Esta carga ya se está acreditando en el casino. Esperá unos segundos y actualizá.');
  eq('en curso trabado', legacyDepositBlock({ casino_deposit_state: 'in_flight', casino_deposit_started_at: new Date(Date.now() - STALE_MS - 1000).toISOString() }), UNKNOWN_DEPOSIT_MSG);

  console.log('— interruptor casino_deposit_guard');
  eq("'true'", await isDepositGuardEnabled(T, fakeDb({ settings: [{ key: 'casino_deposit_guard', tenant_id: T, value: 'true' }] })), true);
  eq('sin fila (default)', await isDepositGuardEnabled(T, fakeDb({ settings: [] })), false);
  eq("'false'", await isDepositGuardEnabled(T, fakeDb({ settings: [{ key: 'casino_deposit_guard', tenant_id: T, value: 'false' }] })), false);
  eq('otro tenant prendido', await isDepositGuardEnabled(T, fakeDb({ settings: [{ key: 'casino_deposit_guard', tenant_id: 'otro', value: 'true' }] })), false);
  eq('error de lectura → apagado', await isDepositGuardEnabled(T, fakeDb({}, { failSettings: true })), false);

  console.log('— guard: doble click (dos pedidos en paralelo, caso real del 03/09)');
  {
    const db = fakeDb({ comprobantes: [comprobante('c1')] });
    const { p, calls } = fakeProvider({ deposit: () => ({ kind: 'ok' }) });
    const args = { provider: p, ctx, tenantId: T, comprobanteId: 'c1', username: 'mariano2gd', amount: 1545 };
    const [a, b] = await Promise.all([guardedDeposit(args, db), guardedDeposit(args, db)]);
    eq('depósitos al casino', calls.deposit, 1);
    eq('uno OK y el otro "ya se está acreditando"', [a.success, b.success ? 'ok' : (b as any).reason].sort(), ['in_progress', true].sort());
  }

  console.log('— guard: ambiguo que se reconcilia por saldo');
  {
    const db = fakeDb({ comprobantes: [comprobante('c2')] });
    const { p, calls } = fakeProvider({ deposit: () => ({ kind: 'ambiguous', reason: 'timeout', error: 'timeout' }), creditOnAmbiguous: true });
    const r = await guardedDeposit({ provider: p, ctx, tenantId: T, comprobanteId: 'c2', username: 'x', amount: 1000 }, db);
    eq('acreditado por reconciliación, sin reintentar', [r.success, (r as any).reconciled, calls.deposit], [true, true, 1]);
  }

  console.log('— guard: ambiguo sin cambio de saldo → a revisar (nunca se libera solo)');
  {
    const rows = [comprobante('c3')];
    const db = fakeDb({ comprobantes: rows });
    const { p, calls } = fakeProvider({ deposit: () => ({ kind: 'ambiguous', reason: 'unavailable', error: 'HTML' }) });
    const r = await guardedDeposit({ provider: p, ctx, tenantId: T, comprobanteId: 'c3', username: 'x', amount: 1000 }, db);
    eq('estado', [r.success, (r as any).state, rows[0].casino_deposit_state, calls.deposit], [false, 'unknown', 'unknown', 1]);
    const again = await guardedDeposit({ provider: p, ctx, tenantId: T, comprobanteId: 'c3', username: 'x', amount: 1000 }, db);
    eq('reintento bloqueado, sin depositar', [(again as any).reason, calls.deposit], ['needs_review', 1]);
    eq('camino de siempre también bloqueado', legacyDepositBlock(rows[0]), UNKNOWN_DEPOSIT_MSG);
  }

  console.log('— guard: rechazo del casino → liberado (seguro reintentar)');
  {
    const rows = [comprobante('c4')];
    const { p } = fakeProvider({ deposit: () => ({ kind: 'not_applied', reason: 'rejected', error: 'Saldo insuficiente' }) });
    const r = await guardedDeposit({ provider: p, ctx, tenantId: T, comprobanteId: 'c4', username: 'x', amount: 1000 }, fakeDb({ comprobantes: rows }));
    eq('liberado', [r.success, (r as any).state, rows[0].casino_deposit_state], [false, 'released', null]);
  }

  console.log('— verify-carga (modo casino, como 17Star): la caja se mueve SOLO con el depósito confirmado');
  for (const [name, dep, cajaEsperada] of [
    ['casino caído antes del depósito', { kind: 'not_applied', reason: 'unavailable', error: 'El casino no está respondiendo.' }, 0],
    ['depósito OK', { kind: 'ok' }, 1],
  ] as const) {
    const rows = [comprobante('c5', { contact_id: 'k', tipo: 'carga' })];
    const db = fakeDb({ comprobantes: rows, contacts: [{ id: 'k', tenant_id: T, name: 'dario3js', casino_username: 'dario3js' }] });
    const { p } = fakeProvider({ deposit: () => dep as ProviderWriteResult });
    let caja = 0; let casinoEnabled: boolean | undefined;
    const deps: VerifyCargaDeps = {
      db,
      guardedDeposit: (args) => guardedDeposit(args, db),
      aplicarCargaComprobante: (async (_s: unknown, a: { casinoEnabled?: boolean }) => { caja++; casinoEnabled = a.casinoEnabled; return { ok: true, applied: true }; }) as any,
      hayStockParaCarga: (async () => { throw new Error('en modo casino no se controla el pozo'); }) as any,
      isCajaEnabled: async () => true,
      logActivity: async () => {},
      broadcast: async () => {},
    };
    const r = await verifyCargaWithProvider({
      session: { tenant_id: T, sub: 'op', name: 'jessica', role: 'agent' } as any,
      comprobante: rows[0], comprobanteId: 'c5', monto: 4000, bono: 125, stockMode: 'casino',
      account: { kind: 'ok', provider: p, ctx, row: {} },
    }, deps);
    eq(`${name}: ok / movimientos de caja`, [r.ok, caja], [cajaEsperada === 1, cajaEsperada]);
    if (cajaEsperada) eq(`${name}: caja en modo casino (pozo intacto)`, casinoEnabled, true);
  }

  console.log(fails ? `\n${fails} FALLA(S)` : '\nTodo OK');
  process.exit(fails ? 1 : 0);
}
main();
