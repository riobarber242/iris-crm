/**
 * READ-ONLY: verifica supabase-campaign-target-total.sql contra la base VIVA.
 * Uso:  node --env-file=.env.local <este archivo>
 */
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const L = (s = '') => console.log(s);

async function main() {
  L('═══════════════════════════════════════════════════════════');
  L(' Verificación — campaigns.target_total');
  L('═══════════════════════════════════════════════════════════\n');

  // 1) ¿Existe la columna? OJO: pedir una columna inexistente NO tira excepción,
  //    devuelve data=null + error 42703. Hay que mirar el error, no el largo de data.
  const { data, error } = await sb.from('campaigns').select('id, name, status, target_total, sent_count').limit(5);
  if (error) {
    const falta = /column .* does not exist|42703/i.test(`${error.code} ${error.message}`);
    L(falta
      ? `❌ La columna NO existe todavía. PostgREST dice: ${error.message}`
      : `⚠ Error inesperado (${error.code}): ${error.message}`);
    process.exit(1);
  }
  L('✅ La columna existe: el select con target_total respondió sin error.');

  // 2) Tipo real: pedimos una fila con valor no nulo, si la hay.
  const { data: conValor, error: e2 } = await sb
    .from('campaigns').select('name, status, target_total, sent_count')
    .not('target_total', 'is', null).limit(5);
  if (e2) L(`⚠ No se pudo consultar filas con valor: ${e2.message}`);

  const { count: total } = await sb.from('campaigns').select('*', { count: 'exact', head: true });
  const { count: llenas } = await sb.from('campaigns').select('*', { count: 'exact', head: true }).not('target_total', 'is', null);
  L(`\nCampañas totales: ${total ?? '?'} · con target_total cargado: ${llenas ?? 0}`);
  if ((llenas ?? 0) === 0) {
    L('   (esperado recién migrado: lo llena runCampaignBatch en la próxima tanda de cada campaña)');
  } else {
    L('');
    for (const c of conValor ?? []) L(`   · ${c.name} [${c.status}] → ${c.sent_count ?? 0} de ${c.target_total}`);
  }

  // 3) Filtrar por la columna: prueba que es usable en WHERE, no solo en el SELECT.
  const { error: e3 } = await sb.from('campaigns').select('id').gt('target_total', 0).limit(1);
  L(`\nUsable en filtros (WHERE target_total > 0): ${e3 ? `❌ ${e3.message}` : '✅ sí'}`);

  // 4) Estado de las campañas activas con cronograma (las que muestran el chip).
  const { data: activas } = await sb
    .from('campaigns').select('name, status, target_total, sent_count, ramp_schedule')
    .not('ramp_schedule', 'is', null)
    .not('status', 'in', '("completada","cancelada")');
  L(`\nCampañas con cronograma activas: ${activas?.length ?? 0}`);
  for (const c of activas ?? []) {
    L(`   · ${c.name} [${c.status}] · target_total=${c.target_total ?? 'null (se llena en la próxima tanda)'}`);
  }
}
main().catch((e) => { console.error('Excepción:', e.message); process.exit(1); });
