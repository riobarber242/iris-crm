/**
 * Limpia el carácter de reemplazo U+FFFD ("�") en content de messages y
 * quick_replies (emojis que se corrompieron al guardarse). Quita el "�" y
 * espacios duplicados resultantes; NO inventa emojis.
 *
 * Uso:
 *   node --env-file=.env.local scripts/fix-corrupted-emojis.ts          # dry-run
 *   node --env-file=.env.local scripts/fix-corrupted-emojis.ts --apply  # aplica
 */
import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error('Faltan env vars. Corré con --env-file=.env.local'); process.exit(1); }
const supabase = createClient(url, key, { auth: { persistSession: false } });
const APPLY = process.argv.includes('--apply');

function clean(s: string): string {
  return s.replace(/�/g, '').replace(/[ \t]{2,}/g, ' ').replace(/ +([\n])/g, '$1').trimEnd();
}

async function fixTable(table: string) {
  const all: any[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from(table).select('id, content').range(from, from + PAGE - 1);
    if (error) { console.error(`Error leyendo ${table}:`, error.message); return; }
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
  }
  const targets = all.filter((r) => typeof r.content === 'string' && r.content.includes('�'));
  console.log(`\n[${table}] con "�": ${targets.length}`);
  for (const r of targets.slice(0, 20)) {
    console.log(`  ${JSON.stringify(r.content)}  →  ${JSON.stringify(clean(r.content))}`);
  }
  if (targets.length > 20) console.log(`  … y ${targets.length - 20} más`);

  if (!APPLY) return;
  let ok = 0, fail = 0;
  for (const r of targets) {
    const { error } = await supabase.from(table).update({ content: clean(r.content) }).eq('id', r.id);
    if (error) { fail++; console.error(`  ✗ ${r.id}: ${error.message}`); } else ok++;
  }
  console.log(`[${table}] aplicado: ${ok} ok, ${fail} error`);
}

async function main() {
  console.log(`=== Fix emojis corruptos (�) — ${APPLY ? 'APPLY' : 'DRY-RUN'} ===`);
  await fixTable('messages');
  await fixTable('quick_replies');
  if (!APPLY) console.log('\nDRY-RUN: no se escribió nada. Volvé a correr con --apply.\n');
}
main().catch((e) => { console.error(e); process.exit(1); });
