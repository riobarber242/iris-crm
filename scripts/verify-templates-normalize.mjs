/**
 * READ-ONLY: verifica el backfill de la Fase 1 (supabase-templates-normalize.sql).
 * Cruza whatsapp_templates ↔ whatsapp_template_wabas de forma independiente al SQL:
 * confirma que cada plantilla con waba_id tiene su fila de estado con los MISMOS
 * valores, que no hay huérfanos inesperados, y que no hay contenido duplicado.
 *
 * Uso:  node --env-file=.env.local scripts/verify-templates-normalize.mjs
 */
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const L = (s = '') => console.log(s);

async function main() {
  L('═══════════════════════════════════════════════════════════════');
  L(' Verificación Fase 1 — normalización de plantillas (backfill)');
  L('═══════════════════════════════════════════════════════════════\n');

  const { data: tpls, error: e1 } = await sb
    .from('whatsapp_templates')
    .select('id, tenant_id, name, language, waba_id, approval_status, meta_template_id, status_synced_at');
  if (e1) { console.error('Error leyendo whatsapp_templates:', e1.message); process.exit(1); }

  const { data: states, error: e2 } = await sb
    .from('whatsapp_template_wabas')
    .select('template_id, waba_id, approval_status, meta_template_id, status_synced_at');
  if (e2) {
    console.error('Error leyendo whatsapp_template_wabas:', e2.message);
    L('\n⚠ ¿Corriste supabase-templates-normalize.sql en el SQL Editor? La tabla todavía no existe.');
    process.exit(1);
  }

  L(`Plantillas (contenido): ${tpls.length}`);
  L(`Filas de estado por WABA: ${states.length}\n`);

  // Índice de estados por (template_id, waba_id).
  const stateKey = (tid, waba) => `${tid}||${waba}`;
  const stateMap = new Map(states.map((s) => [stateKey(s.template_id, s.waba_id), s]));

  // 1) Cada plantilla con waba_id → debe tener su fila de estado con valores iguales.
  let ok = 0, mismatch = 0, missing = 0, legacy = 0;
  L('── Cruce plantilla → estado ──');
  for (const t of tpls) {
    if (!t.waba_id) { legacy++; L(`  ⚪ ${t.name} (${t.language}) — LEGACY (waba_id null) → sin fila de estado (esperado)`); continue; }
    const s = stateMap.get(stateKey(t.id, t.waba_id));
    if (!s) { missing++; L(`  ❌ ${t.name} (${t.language}) waba=${t.waba_id.slice(0,10)} — FALTA fila de estado`); continue; }
    const same = (s.approval_status ?? null) === (t.approval_status ?? null)
      && (s.meta_template_id ?? null) === (t.meta_template_id ?? null);
    if (same) { ok++; L(`  ✅ ${t.name} (${t.language}) waba=${t.waba_id.slice(0,10)} status=${s.approval_status ?? '-'}`); }
    else { mismatch++; L(`  ⚠ ${t.name} — VALORES DISTINTOS: tpl(status=${t.approval_status},meta=${t.meta_template_id}) vs estado(status=${s.approval_status},meta=${s.meta_template_id})`); }
  }

  // 2) Estados huérfanos (sin plantilla) — no debería haber (FK + cascade).
  const tplIds = new Set(tpls.map((t) => t.id));
  const orphanStates = states.filter((s) => !tplIds.has(s.template_id));

  // 3) Contenido duplicado (tenant, name, language) — debe ser 0.
  const seen = new Map();
  const dups = [];
  for (const t of tpls) {
    const k = `${t.tenant_id}||${t.name.trim().toLowerCase()}||${(t.language||'').trim().toLowerCase()}`;
    if (seen.has(k)) dups.push(t.name); else seen.set(k, true);
  }

  L('\n── Resumen ──');
  L(`  ✅ Migradas 1:1 (valores idénticos): ${ok}`);
  L(`  ⚪ Legacy sin estado (esperado): ${legacy}`);
  L(`  ${missing ? '❌' : '✅'} Plantillas con waba_id SIN estado: ${missing}`);
  L(`  ${mismatch ? '⚠' : '✅'} Estados con valores distintos al origen: ${mismatch}`);
  L(`  ${orphanStates.length ? '⚠' : '✅'} Estados huérfanos (sin plantilla): ${orphanStates.length}`);
  L(`  ${dups.length ? '⚠' : '✅'} Contenido duplicado (tenant,name,language): ${dups.length}${dups.length ? ' → ' + dups.join(', ') : ''}`);

  const clean = missing === 0 && mismatch === 0 && orphanStates.length === 0 && dups.length === 0;
  L('');
  L(clean
    ? '🟢 BACKFILL OK — datos migrados 1:1, sin huérfanos ni duplicados. Listo para Fase 2.'
    : '🔴 Hay algo para revisar antes de seguir (ver arriba).');
}
main().catch((e) => { console.error('EX', e); process.exit(1); });
