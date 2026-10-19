/**
 * Verificación READ-ONLY del paginado de resolveContacts (tope de 1.000 filas).
 * NO envía nada, NO crea ni toca campañas: solo lee contactos/comprobantes.
 *
 * Uso: npx tsx --env-file=.env.local scripts/verify-campaign-paginado.ts
 *
 * · Derki: "nuevo" × alcance "lineas" sin líneas emisoras (como la campaña real
 *   "todos" del 27/07) tiene que dar el COUNT exacto de la base, no 1.000.
 * · Casino 17Star y Alina17star: para cada categoría × alcance, el resultado nuevo
 *   tiene que ser el MISMO conjunto de ids que la consulta vieja sin paginar
 *   (estos tenants están debajo de 1.000, así que la vieja no se recortaba).
 */
import { createClient } from '@supabase/supabase-js';
import { resolveContacts } from '../src/lib/campaigns/send-core';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const FILTERS = ['todos', 'nuevo', 'cliente_activo', 'inactivo', 'en_proceso', 'inactivo_30d'];
const SCOPES  = ['lineas', 'suelto', 'libre'] as const;

async function tenantId(name: string): Promise<string> {
  const { data, error } = await sb.from('tenants').select('id').eq('name', name).single();
  if (error || !data) throw new Error(`tenant ${name}: ${error?.message}`);
  return data.id;
}

// Réplica EXACTA de la consulta vieja (sin paginar), para comparar.
async function oldResolve(filter: string, tid: string, scope: string): Promise<string[]> {
  let base: any = sb.from('contacts').select('id').eq('tenant_id', tid).neq('blocked', true)
    .order('created_at', { ascending: true });
  if (scope === 'suelto') base = base.is('whatsapp_number_id', null);
  const m = filter.match(/^inactivo_(\d+)d$/);
  if (m) {
    const cutoff = new Date(Date.now() - Number(m[1]) * 86_400_000).toISOString();
    const [{ data: inact }, { data: rec }] = await Promise.all([
      base.eq('status', 'inactivo'),
      sb.from('comprobantes').select('contact_id').eq('tenant_id', tid).eq('estado', 'verificado').gte('created_at', cutoff),
    ]);
    const recent = new Set((rec ?? []).map((r: any) => r.contact_id));
    return (inact ?? []).filter((c: any) => !recent.has(c.id)).map((c: any) => c.id);
  }
  const q = filter === 'todos' ? base : base.eq('status', filter);
  const { data } = await q;
  return (data ?? []).map((c: any) => c.id);
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x)) && s.size === a.length;
}

async function main() {
  // ── Derki ──
  const derki = await tenantId('derqui17star');
  const { count: expected } = await sb.from('contacts').select('id', { count: 'exact', head: true })
    .eq('tenant_id', derki).neq('blocked', true).eq('status', 'nuevo');
  const res = await resolveContacts('nuevo', derki, 'lineas', [], []);
  if ('error' in res) throw new Error(res.error);
  const ids = res.rows.map((r) => r.id);
  const dup = ids.length - new Set(ids).size;
  const viejo = (await oldResolve('nuevo', derki, 'lineas')).length;
  console.log(`Derki nuevo/lineas: nuevo=${ids.length} (duplicados=${dup}) · count base=${expected} · consulta vieja=${viejo} → ${ids.length === expected && dup === 0 ? 'OK' : 'FALLA'}`);

  // ── Casino y Alina: mismo conjunto que antes ──
  let fallas = 0;
  for (const name of ['Casino 17Star', 'Alina17star']) {
    const tid = await tenantId(name);
    for (const f of FILTERS) for (const sc of SCOPES) {
      const nuevo = await resolveContacts(f, tid, sc, [], []);
      if ('error' in nuevo) { console.log(`${name} ${f}/${sc}: ERROR ${nuevo.error}`); fallas++; continue; }
      const antes = await oldResolve(f, tid, sc);
      const ok = sameSet(nuevo.rows.map((r) => r.id), antes);
      if (!ok) fallas++;
      console.log(`${name} ${f}/${sc}: nuevo=${nuevo.rows.length} antes=${antes.length} ${ok ? 'OK' : 'DISTINTO'}`);
    }
  }
  console.log(fallas === 0 ? '\nTodo OK' : `\n${fallas} diferencias`);
}

main().catch((e) => { console.error(e); process.exit(1); });
