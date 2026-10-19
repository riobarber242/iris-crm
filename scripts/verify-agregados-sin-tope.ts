/**
 * Comparación READ-ONLY antes / real / nuevo para el commit 3 (agregados en la
 * base en vez de filas cortadas en 1.000). No escribe nada.
 *
 *   antes = la consulta vieja tal cual (sin range → PostgREST corta en 1.000)
 *   real  = lo mismo paginado en JS hasta traer todo (la verdad)
 *   nuevo = la RPC de supabase-agregados-sin-tope-rpcs.sql (lo que usa el código nuevo)
 *
 * Uso: npx tsx --env-file=.env.local scripts/verify-agregados-sin-tope.ts ["Casino 17Star"]
 */
import { createClient } from '@supabase/supabase-js';
import { classifyPending } from '../src/lib/pending';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const TENANT = process.argv[2] ?? 'Casino 17Star';

async function all<T = any>(build: () => any): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}
async function rpc(fn: string, args: any): Promise<any> {
  const { data, error } = await sb.rpc(fn, args);
  if (error) return { __err: error.code === 'PGRST202' ? 'falta correr el SQL' : error.message };
  return data;
}
const fmt = (n: any) => (typeof n === 'number' ? n.toLocaleString('es-AR') : String(n));
let difs = 0;
function row(label: string, antes: any, real: any, nuevo: any) {
  const nv = nuevo?.__err ? `⚠ ${nuevo.__err}` : nuevo;
  const ok = nuevo?.__err ? '' : (JSON.stringify(nv) === JSON.stringify(real) ? '✅' : '❌');
  if (ok === '❌') difs++;
  console.log(`${label.padEnd(44)} antes=${fmt(antes).padEnd(14)} real=${fmt(real).padEnd(14)} nuevo=${fmt(nv)} ${ok}`);
}

async function main() {
  const { data: t } = await sb.from('tenants').select('id').eq('name', TENANT).single();
  const tid = t!.id as string;
  console.log(`\n=== ${TENANT} ===\n`);

  // Fronteras AR (igual que el código).
  const OFF = 3 * 3600_000;
  const a = new Date(Date.now() - OFF);
  const y = a.getUTCFullYear(), m = a.getUTCMonth(), d = a.getUTCDate();
  const todayStart = new Date(Date.UTC(y, m, d, 3)).toISOString();
  const weekStart  = new Date(Date.UTC(y, m, d - ((a.getUTCDay() + 6) % 7), 3)).toISOString();
  const monthStart = new Date(Date.UTC(y, m, 1, 3)).toISOString();
  const prevStart  = new Date(Date.UTC(y, m - 1, 1, 3)).toISOString();

  // ── 1) Billetera ──────────────────────────────────────────────────────────
  console.log('— Caja: billetera del operador');
  const { data: ops } = await sb.from('agents').select('id, name').eq('tenant_id', tid).eq('role', 'operator');
  for (const op of ops ?? []) {
    const base = () => sb.from('movimientos').select('id, billetera_delta, created_at, tipo, monto')
      .eq('tenant_id', tid).eq('operador_id', op.id).neq('billetera_delta', 0)
      .order('created_at', { ascending: true }).order('id', { ascending: true });
    const { data: viejo } = await sb.from('movimientos').select('billetera_delta')
      .eq('tenant_id', tid).eq('operador_id', op.id).neq('billetera_delta', 0).order('created_at', { ascending: true });
    const real = await all(base);
    if (real.length === 0) continue;
    const saldoViejo = (viejo ?? []).reduce((s: number, r: any) => s + Number(r.billetera_delta), 0);
    let s = 0; const runReal = new Map<string, number>();
    for (const r of real) { s += Number(r.billetera_delta); runReal.set(r.id, s); }
    const { data: bil } = await sb.from('operador_billetera').select('saldo_actual').eq('tenant_id', tid).eq('operador_id', op.id).maybeSingle();
    const nuevo = await rpc('fn_caja_billetera_movimientos', { p_tenant_id: tid, p_operador_id: op.id, p_limit: 500 });
    const n = Array.isArray(nuevo) ? nuevo : null;
    row(`${op.name}: movimientos (total)`, (viejo ?? []).length, real.length, n ? Number(n[0]?.total ?? 0) : nuevo);
    row(`${op.name}: filas que ve la pantalla`, (viejo ?? []).length, Math.min(500, real.length), n ? n.length : nuevo);
    row(`${op.name}: saldo de la última fila`, saldoViejo, s, n ? Number(n[n.length - 1]?.saldo_corriendo) : nuevo);
    if (n) {
      const malas = n.filter((r: any) => runReal.get(r.id) !== Number(r.saldo_corriendo)).length;
      row(`${op.name}: filas con saldo distinto al real`, '-', 0, malas);
    }
    console.log(`${''.padEnd(44)} (saldo_actual en operador_billetera = ${fmt(Number(bil?.saldo_actual ?? 0))})`);

    // Resumen del turno (hoy AR)
    const turnoViejo = await sb.from('movimientos').select('tipo, monto').eq('tenant_id', tid).eq('operador_id', op.id).gte('created_at', todayStart);
    const turnoReal = await all(() => sb.from('movimientos').select('tipo, monto').eq('tenant_id', tid).eq('operador_id', op.id).gte('created_at', todayStart).order('id'));
    const sum = (rows: any[], tp: string) => rows.filter((r) => r.tipo === tp).reduce((q, r) => q + Number(r.monto ?? 0), 0);
    const tn = await rpc('fn_caja_resumen_turno', { p_tenant_id: tid, p_operador_id: op.id, p_since: todayStart });
    for (const tp of ['carga', 'pago', 'descarga', 'sueldo']) {
      row(`${op.name}: turno hoy ${tp}`, sum(turnoViejo.data ?? [], tp), sum(turnoReal, tp),
        Array.isArray(tn) ? Number(tn.find((r: any) => r.tipo === tp)?.total ?? 0) : tn);
    }
  }

  // ── 2) dashboard_metric ───────────────────────────────────────────────────
  console.log('\n— Dashboard: widgets personalizados');
  const periods: [string, string, string | null][] = [
    ['hoy', todayStart, null], ['semana', weekStart, null], ['mes', monthStart, null], ['mes_anterior', prevStart, monthStart],
  ];
  const conv = await rpc('fn_dashboard_conv_counts', { p_tenant_id: tid, p_today_start: todayStart, p_week_start: weekStart, p_month_start: monthStart, p_prev_start: prevStart, p_prev_end: monthStart });
  const convKey: Record<string, string> = { hoy: 'conv_today', semana: 'conv_week', mes: 'conv_month', mes_anterior: 'conv_prev_month' };
  for (const [p, gte, lt] of periods) {
    const q = () => { let x: any = sb.from('messages').select('contact_id').eq('tenant_id', tid).gte('created_at', gte); if (lt) x = x.lt('created_at', lt); return x; };
    const viejo = new Set(((await q()).data ?? []).map((r: any) => r.contact_id)).size;
    const real = new Set((await all(() => q().order('id'))).map((r: any) => r.contact_id)).size;
    row(`conversaciones ${p}`, viejo, real, conv?.__err ? conv : Number(conv[0][convKey[p]]));
  }
  for (const [p, gte, lt] of [...periods, ['histórico', null, null] as any]) {
    const q = () => { let x: any = sb.from('comprobantes').select('monto').eq('tenant_id', tid).eq('estado', 'verificado'); if (gte) x = x.gte('created_at', gte); if (lt) x = x.lt('created_at', lt); return x; };
    const s = (rows: any[]) => rows.reduce((acc, r) => acc + Number(r.monto ?? 0), 0);
    const nv = await rpc('fn_comprobantes_verificados', { p_tenant_id: tid, p_gte: gte, p_lt: lt });
    row(`monto verificado ${p}`, s((await q()).data ?? []), s(await all(() => q().order('id'))), nv?.__err ? nv : Number(nv[0].monto));
  }

  // ── 3) dashboard_charts ───────────────────────────────────────────────────
  console.log('\n— Dashboard: gráficos');
  const cViejo = (await sb.from('contacts').select('status, provincia').eq('tenant_id', tid)).data ?? [];
  const cReal = await all(() => sb.from('contacts').select('status, provincia').eq('tenant_id', tid).order('id'));
  const cNew = await rpc('fn_contacts_breakdown', { p_tenant_id: tid });
  const byStatus = (rows: any[], w = (_: any) => 1) => rows.reduce((acc: any, r: any) => { const k = r.status ?? 'nuevo'; acc[k] = (acc[k] ?? 0) + w(r); return acc; }, {});
  for (const st of ['cliente_activo', 'nuevo', 'inactivo', 'en_proceso', 'bloqueado']) {
    row(`contactos ${st}`, byStatus(cViejo)[st] ?? 0, byStatus(cReal)[st] ?? 0, cNew?.__err ? cNew : (byStatus(cNew, (r) => Number(r.n))[st] ?? 0));
  }
  const provs = (rows: any[]) => new Set(rows.filter((r) => r.provincia).map((r) => r.provincia)).size;
  row('provincias con contactos', provs(cViejo), provs(cReal), cNew?.__err ? cNew : provs(cNew));
  const eViejo = (await sb.from('comprobantes').select('estado').eq('tenant_id', tid)).data ?? [];
  const eReal = await all(() => sb.from('comprobantes').select('estado').eq('tenant_id', tid).order('id'));
  const eNew = await rpc('fn_comprobantes_por_estado', { p_tenant_id: tid });
  const byE = (rows: any[], w = (_: any) => 1) => rows.reduce((acc: any, r: any) => { const k = r.estado ?? 'pendiente'; acc[k] = (acc[k] ?? 0) + w(r); return acc; }, {});
  for (const e of ['verificado', 'pendiente', 'rechazado']) {
    row(`comprobantes ${e}`, byE(eViejo)[e] ?? 0, byE(eReal)[e] ?? 0, eNew?.__err ? eNew : (byE(eNew, (r) => Number(r.n))[e] ?? 0));
  }
  // Recaudación por mes (UTC, como el server).
  const now = new Date();
  const six = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5, 1)).toISOString();
  const rq = () => sb.from('comprobantes').select('monto, created_at').eq('tenant_id', tid).eq('estado', 'verificado').gte('created_at', six);
  const byM = (rows: any[]) => rows.reduce((acc: any, r: any) => { const dd = new Date(r.created_at); const k = `${dd.getUTCFullYear()}-${dd.getUTCMonth() + 1}`; acc[k] = (acc[k] ?? 0) + Number(r.monto ?? 0); return acc; }, {});
  const mViejo = byM((await rq()).data ?? []), mReal = byM(await all(() => rq().order('id')));
  const mNew = await rpc('fn_recargas_por_mes', { p_tenant_id: tid, p_since: six });
  const mNewMap = Array.isArray(mNew) ? Object.fromEntries(mNew.map((r: any) => [`${r.anio}-${r.mes}`, Number(r.monto)])) : null;
  for (let i = 5; i >= 0; i--) {
    const dd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const k = `${dd.getUTCFullYear()}-${dd.getUTCMonth() + 1}`;
    row(`recaudación ${k}`, mViejo[k] ?? 0, mReal[k] ?? 0, mNewMap ? (mNewMap[k] ?? 0) : mNew);
  }

  // ── 4) Pendientes (dashboard + contador + Iris) ───────────────────────────
  console.log('\n— Sin responder (dashboard, contador de no leídos, Iris AI)');
  const count = (rows: any[]) => rows.reduce((acc, c) => {
    const l = classifyPending({ lastRole: c.last_role, lastMsgAt: c.last_msg_at, lastReadAt: c.last_read_at, conversationState: c.conversation_state, humanTaken: c.human_taken });
    if (l) acc[l]++; return acc;
  }, { orange: 0, red: 0 } as any);
  const snapViejo = (await sb.rpc('fn_contacts_pending_snapshot', { p_tenant_id: tid })).data ?? [];
  const snapReal = await all(() => sb.rpc('fn_contacts_pending_snapshot', { p_tenant_id: tid }).order('id'));
  const candN = await rpc('fn_contacts_pending_candidates', { p_tenant_id: tid });
  const cv = count(snapViejo), cr = count(snapReal), cn = Array.isArray(candN) ? count(candN) : null;
  row('pendientes naranja', cv.orange, cr.orange, cn ? cn.orange : candN);
  row('pendientes rojo', cv.red, cr.red, cn ? cn.red : candN);
  row('filas que viajan (snapshot → candidatos)', snapViejo.length, snapReal.length, Array.isArray(candN) ? candN.length : candN);

  // ── 5) Export ─────────────────────────────────────────────────────────────
  console.log('\n— Exportar contactos (CSV)');
  const { count: total } = await sb.from('contacts').select('id', { count: 'exact', head: true }).eq('tenant_id', tid);
  const exViejo = (await sb.from('contacts').select('id').eq('tenant_id', tid).order('created_at', { ascending: false })).data?.length ?? 0;
  const exNuevo = (await all(() => sb.from('contacts').select('id').eq('tenant_id', tid).order('created_at', { ascending: false }).order('id', { ascending: false }))).length;
  row('filas del CSV', exViejo, total, exNuevo);

  // ── 6) ramp_used_today (con las campañas del tenant, desde hace 30 días) ──
  console.log('\n— Campañas: envíos por campaña (mismo conteo que ramp_used_today)');
  const { data: camps } = await sb.from('campaigns').select('id, name').eq('tenant_id', tid).order('created_at', { ascending: false }).limit(5);
  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  const ids = (camps ?? []).map((c: any) => c.id);
  const rViejo = (await sb.from('campaign_recipients').select('campaign_id').in('campaign_id', ids).gte('sent_at', since)).data ?? [];
  const rReal = await all(() => sb.from('campaign_recipients').select('campaign_id').in('campaign_id', ids).gte('sent_at', since).order('id'));
  const rNew = await rpc('fn_campaign_recipients_since', { p_tenant_id: tid, p_campaign_ids: ids, p_since: since });
  const tally = (rows: any[]) => rows.reduce((acc: any, r: any) => { acc[r.campaign_id] = (acc[r.campaign_id] ?? 0) + 1; return acc; }, {});
  for (const c of camps ?? []) {
    row(`"${c.name}" envíos 30d`, tally(rViejo)[c.id] ?? 0, tally(rReal)[c.id] ?? 0,
      Array.isArray(rNew) ? Number(rNew.find((r: any) => r.campaign_id === c.id)?.n ?? 0) : rNew);
  }

  console.log(difs === 0 ? '\nnuevo = real en todo lo que se pudo comparar' : `\n❌ ${difs} diferencias nuevo vs real`);
}
main().catch((e) => { console.error(e); process.exit(1); });
