/** READ-ONLY: replica las queries de los endpoints calientes y las cronometra. */
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const { data: tenants } = await sb.from('tenants').select('id, name, plan');
console.log('TENANTS:', tenants.map(t => `${t.name}(${t.plan})`).join(', '));
const { data: agentsAll } = await sb.from('agents').select('id, name, role, tenant_id, active');

// Piso de red: query trivial repetida
let floor = [];
for (let i = 0; i < 5; i++) { const t0 = Date.now(); await sb.from('tenants').select('id').limit(1); floor.push(Date.now() - t0); }
floor.sort((a,b)=>a-b);
const FLOOR = floor[2];
console.log(`\nPISO DE RED (mediana de 5 queries triviales): ${FLOOR} ms  <- restar esto para estimar el costo real en gru1\n`);

async function time(label, fn, reps = 3) {
  const ts = [];
  let extra = '';
  for (let i = 0; i < reps; i++) { const t0 = Date.now(); extra = (await fn()) ?? ''; ts.push(Date.now() - t0); }
  ts.sort((a,b)=>a-b);
  const med = ts[Math.floor(reps/2)];
  console.log(`${label.padEnd(52)} ${String(med).padStart(6)} ms  (neto ~${Math.max(0,med-FLOOR)} ms) ${extra}`);
  return med;
}

for (const t of tenants) {
  console.log(`\n================= TENANT: ${t.name} =================`);
  const tid = t.id;
  const ags = agentsAll.filter(a => a.tenant_id === tid && a.active);
  const ag  = ags[0];

  // ── /api/unread_counts : 1 RPC + 2 counts ──
  await time('unread_counts · RPC fn_contacts_pending_snapshot', async () => {
    const { data, error } = await sb.rpc('fn_contacts_pending_snapshot', { p_tenant_id: tid });
    return error ? 'ERROR ' + error.message : `${data?.length ?? 0} filas, ${JSON.stringify(data ?? []).length} B`;
  });
  await time('unread_counts · count comprobantes(carga)', async () => {
    const { count } = await sb.from('comprobantes').select('id', { count: 'exact', head: true }).eq('estado','pendiente').eq('tenant_id', tid).eq('tipo','carga');
    return `count=${count}`;
  });
  await time('unread_counts · count comprobantes(pago)', async () => {
    const { count } = await sb.from('comprobantes').select('id', { count: 'exact', head: true }).eq('estado','pendiente').eq('tenant_id', tid).eq('tipo','pago');
    return `count=${count}`;
  });

  // ── /api/auth/me : 2 selects ──
  if (ag) {
    await time('auth/me · select agents by id', async () => { await sb.from('agents').select('id,name,role,active,can_see_top_clients,can_see_campaigns,avatar_url,phone,session_timeout_enabled,session_timeout_minutes').eq('id', ag.id).maybeSingle(); });
  }
  await time('auth/me · select tenants.plan', async () => { await sb.from('tenants').select('plan').eq('id', tid).maybeSingle(); });

  // ── /api/internal/unread : N+1 ──
  const { data: rooms } = await sb.from('internal_rooms').select('id, kind, participant_a, participant_b').eq('tenant_id', tid);
  if (ag && rooms?.length) {
    const mine = rooms.filter(r => r.kind === 'group' || r.participant_a === ag.id || r.participant_b === ag.id);
    await time(`internal/unread · TOTAL (${mine.length} salas => ${1 + mine.length*2} roundtrips)`, async () => {
      await sb.from('internal_rooms').select('id, kind, participant_a, participant_b').eq('tenant_id', tid).or(`kind.eq.group,participant_a.eq.${ag.id},participant_b.eq.${ag.id}`);
      for (const r of mine) {
        const { data: rr } = await sb.from('internal_room_reads').select('last_read_at').eq('room_id', r.id).eq('agent_id', ag.id).maybeSingle();
        let q = sb.from('internal_messages').select('id', { count:'exact', head:true }).eq('tenant_id', tid).eq('room_id', r.id).neq('author_id', ag.id);
        if (rr?.last_read_at) q = q.gt('created_at', rr.last_read_at);
        await q;
      }
      return `salas=${mine.length}`;
    });
  }
}
