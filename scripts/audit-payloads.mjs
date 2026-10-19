/** READ-ONLY: mide el TAMAÑO de payload de los endpoints polleados. */
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const kb = (n) => (n/1024).toFixed(1) + ' KB';
const { data: tenants } = await sb.from('tenants').select('id, name');

for (const t of tenants) {
  if (t.name === 'Principal') continue;
  console.log(`\n================= ${t.name} =================`);

  // /api/conversations (poll 60s) — RPC fn_conversations_list
  let t0 = Date.now();
  const { data: convs, error: cErr } = await sb.rpc('fn_conversations_list', { p_tenant_id: t.id, p_status: null, p_search: null });
  const convMs = Date.now() - t0;
  if (cErr) console.log('  conversations RPC ERROR:', cErr.message);
  else console.log(`  /api/conversations   ${String(convs?.length??0).padStart(5)} convs  ${kb(JSON.stringify((convs??[]).map(r=>r.row)).length).padStart(10)}  ${convMs} ms   [poll 60s]`);

  // /api/unread_counts (poll 15s)
  t0 = Date.now();
  const { data: snap } = await sb.rpc('fn_contacts_pending_snapshot', { p_tenant_id: t.id });
  console.log(`  unread_counts RPC    ${String(snap?.length??0).padStart(5)} filas  ${kb(JSON.stringify(snap??[]).length).padStart(10)}  ${Date.now()-t0} ms   [poll 15s] <- se usa solo para 2 enteros`);

  // /api/messages (poll 8s) — historial COMPLETO por contacto, sin limit
  const { data: top } = await sb.from('messages').select('contact_id').eq('tenant_id', t.id).limit(20000);
  const cnt = {}; for (const m of top ?? []) cnt[m.contact_id] = (cnt[m.contact_id]||0)+1;
  const ranked = Object.entries(cnt).sort((a,b)=>b[1]-a[1]).slice(0,3);
  console.log(`  --- /api/messages (historial completo, sin LIMIT, poll 8s) ---`);
  for (const [cid, n] of ranked) {
    t0 = Date.now();
    const { data: msgs } = await sb.from('messages').select('*').eq('contact_id', cid).eq('tenant_id', t.id).order('created_at', { ascending: false });
    const bytes = JSON.stringify(msgs??[]).length;
    console.log(`     contacto ${cid.slice(0,8)}  ${String(n).padStart(4)} msgs  ${kb(bytes).padStart(10)}  ${Date.now()-t0} ms  => ${kb(bytes*7.5)}/min por pestaña abierta`);
  }
  const totalMsgs = (top??[]).length;
  const convCount = Object.keys(cnt).length;
  console.log(`     (promedio ${(totalMsgs/Math.max(1,convCount)).toFixed(0)} msgs/conversación sobre ${convCount} conversaciones)`);

  // /api/comprobantes (poll 30s) — página de 50
  t0 = Date.now();
  const { data: comp } = await sb.from('comprobantes').select('*, contacts(phone, name, casino_username)').eq('tenant_id', t.id).order('created_at',{ascending:false}).limit(50);
  console.log(`  /api/comprobantes    ${String(comp?.length??0).padStart(5)} filas  ${kb(JSON.stringify(comp??[]).length).padStart(10)}  ${Date.now()-t0} ms   [poll 30s]`);
}
