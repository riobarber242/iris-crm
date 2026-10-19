/** READ-ONLY: verifica la migración de fn_conversations_list paginada. */
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const kb = n => (n/1024).toFixed(1)+' KB';
const { data: tn } = await sb.from('tenants').select('id,name');
const T = tn.find(x => x.name === 'Casino 17Star');
const call = (p) => sb.rpc('fn_conversations_list', { p_tenant_id: T.id, p_status: null, p_search: null, p_unread_only: false, p_limit: null, p_before_at: null, p_before_id: null, ...p });
let ok = 0, fail = 0;
const check = (name, cond, extra='') => { console.log(`  ${cond?'✓':'✗'} ${name}${extra?'  — '+extra:''}`); cond ? ok++ : fail++; };

console.log('=== 1. COMPATIBILIDAD: llamada vieja de 3 argumentos ===');
let t0 = Date.now();
const old = await sb.rpc('fn_conversations_list', { p_tenant_id: T.id, p_status: null, p_search: null });
const oldMs = Date.now() - t0;
check('sin error', !old.error, old.error?.message ?? '');
check('devuelve TODO (857), no una página', old.data?.length === 857, `${old.data?.length} filas en ${oldMs} ms`);

console.log('\n=== 2. PAGINACIÓN keyset ===');
t0 = Date.now();
const p1 = await call({ p_limit: 50 });
const p1ms = Date.now() - t0;
check('página 1 = 50 filas', p1.data?.length === 50, `${p1ms} ms · ${kb(JSON.stringify(p1.data ?? []).length)}`);
const rows1 = (p1.data ?? []).map(r => r.row);
const last1 = rows1[rows1.length - 1];
t0 = Date.now();
const p2 = await call({ p_limit: 50, p_before_at: last1.messages[0].created_at, p_before_id: last1.id });
const p2ms = Date.now() - t0;
const rows2 = (p2.data ?? []).map(r => r.row);
check('página 2 = 50 filas', rows2.length === 50, `${p2ms} ms`);
const ids1 = new Set(rows1.map(r => r.id));
check('página 2 NO repite filas de la 1', !rows2.some(r => ids1.has(r.id)));
const ord = (rs) => rs.every((r,i) => i===0 || rs[i-1].messages[0].created_at >= r.messages[0].created_at);
check('orden DESC por último mensaje se mantiene', ord(rows1) && ord(rows2));
check('la 2 arranca donde terminó la 1', rows2[0].messages[0].created_at <= last1.messages[0].created_at);

console.log('\n=== 3. FILTROS server-side ===');
const st = await call({ p_status: 'cliente_activo', p_limit: 200 });
check('status=cliente_activo sólo trae ese estado',
  (st.data ?? []).every(r => (r.row.status ?? '').toLowerCase() === 'cliente_activo'), `${st.data?.length} filas`);
const bl = await call({ p_status: 'bloqueado', p_limit: 200 });
check('status=bloqueado mira c.blocked (no c.status)',
  (bl.data ?? []).every(r => r.row.blocked === true), `${bl.data?.length} filas`);
const un = await call({ p_unread_only: true, p_limit: 200 });
check('unread_only excluye los que terminan en mensaje humano',
  (un.data ?? []).every(r => r.row.messages[0].role !== 'human'), `${un.data?.length} filas`);
// búsqueda por casino_username (lo que antes hacía sólo el cliente)
const alguno = rows1.find(r => (r.casino_username ?? '').trim().length > 3);
if (alguno) {
  const term = alguno.casino_username.trim().slice(0, 4);
  const se = await call({ p_search: term, p_limit: 200 });
  const hit = (se.data ?? []).some(r => r.row.id === alguno.id);
  check(`búsqueda por casino_username ("${term}") encuentra el contacto`, hit, `${se.data?.length} resultados`);
}

console.log('\n=== 4. GANANCIA ===');
const oldBytes = JSON.stringify((old.data ?? []).map(r => r.row)).length;
const newBytes = JSON.stringify(rows1).length;
console.log(`  payload  ${kb(oldBytes)} → ${kb(newBytes)}   (${(100 - newBytes/oldBytes*100).toFixed(1)}% menos)`);
console.log(`  query    ${oldMs} ms → ${p1ms} ms (pág.1) / ${p2ms} ms (pág.2)`);

console.log(`\n${fail === 0 ? '✅ TODO OK' : '❌ ' + fail + ' FALLARON'}  (${ok} checks pasados)`);
