/**
 * READ-ONLY: verifica la migración correctiva (supabase-templates-denormalize.sql).
 * Confirma que la tabla de estado se dropeó y que las plantillas quedaron intactas
 * con su contenido + estado en la misma fila (modelo independiente por cuenta).
 *
 * Uso:  node --env-file=.env.local scripts/verify-templates-denormalize.mjs
 */
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const L = (s = '') => console.log(s);

async function main() {
  L('═══════════════════════════════════════════════════════════════');
  L(' Verificación — modelo independiente por cuenta');
  L('═══════════════════════════════════════════════════════════════\n');

  // 1) La tabla de estado NO debe existir.
  const { error: stErr } = await sb.from('whatsapp_template_wabas').select('template_id').limit(1);
  const tablaDropeada = !!stErr && /does not exist|schema cache|relation/i.test(stErr.message ?? '');
  L(`Tabla whatsapp_template_wabas dropeada: ${tablaDropeada ? '✅ sí' : '❌ NO (sigue existiendo)'}`);
  if (stErr && !tablaDropeada) L(`   (error inesperado: ${stErr.message})`);

  // 2) Plantillas intactas: contenido + estado en la misma fila.
  const { data: tpls, error } = await sb
    .from('whatsapp_templates')
    .select('name, language, waba_id, approval_status, body, buttons')
    .order('name');
  if (error) { console.error('Error leyendo whatsapp_templates:', error.message); process.exit(1); }

  L(`\nPlantillas: ${tpls.length}`);
  let sinWaba = 0, sinContenido = 0;
  for (const t of tpls) {
    if (!t.waba_id) sinWaba++;
    if (!t.body) sinContenido++;
    L(`  · ${t.name} (${t.language}) waba=${(t.waba_id ?? 'null').slice(0, 10)} status=${t.approval_status ?? '-'} body=${t.body ? '✓' : '✗'} botones=${Array.isArray(t.buttons) ? t.buttons.length : 0}`);
  }

  // 3) Duplicados por cuenta (no debería haber tras el unique nuevo).
  const seen = new Map();
  let dupCuenta = 0;
  for (const t of tpls) {
    const k = `${t.name}|${t.language}|${t.waba_id ?? 'null'}`;
    if (seen.has(k)) dupCuenta++; else seen.set(k, true);
  }

  L('\n── Resumen ──');
  L(`  ${tablaDropeada ? '✅' : '❌'} Tabla de estado dropeada`);
  L(`  ${sinContenido === 0 ? '✅' : '❌'} Todas con contenido (body): ${tpls.length - sinContenido}/${tpls.length}`);
  L(`  ${dupCuenta === 0 ? '✅' : '⚠'} Duplicados (name,language,waba): ${dupCuenta}`);
  L(`  ${sinWaba === 0 ? '✅' : '⚠'} Filas sin waba_id (legacy): ${sinWaba}`);

  const ok = tablaDropeada && sinContenido === 0 && dupCuenta === 0;
  L('');
  L(ok ? '🟢 Modelo independiente OK — listo para revertir código y encarar la pantalla.'
       : '🔴 Revisar lo marcado arriba antes de seguir.');
}
main().catch((e) => { console.error('EX', e); process.exit(1); });
