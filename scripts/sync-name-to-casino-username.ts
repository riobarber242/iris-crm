/**
 * Copia name → casino_username para los contactos que tienen name pero NO
 * tienen casino_username. NUNCA sobreescribe un casino_username existente.
 *
 * Backfill de la base actual (run once). Para los contactos NUEVOS o editados,
 * ver supabase-sync-username.sql (trigger en la DB que hace lo mismo automático).
 *
 * Uso:
 *   node --env-file=.env.local scripts/sync-name-to-casino-username.ts          # dry-run
 *   node --env-file=.env.local scripts/sync-name-to-casino-username.ts --apply  # aplica
 */
import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) { console.error('Faltan env vars. Corré con --env-file=.env.local'); process.exit(1); }

const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });
const APPLY = process.argv.includes('--apply');

const isEmpty = (v: string | null | undefined) => !v || v.trim() === '';

type Contact = { id: string; name: string | null; casino_username: string | null };

async function main() {
  console.log(`\n=== Sync name → casino_username — modo ${APPLY ? 'APPLY (escribe)' : 'DRY-RUN (no escribe)'} ===\n`);

  // Traer todos los contactos (paginado).
  const all: Contact[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('contacts')
      .select('id, name, casino_username')
      .order('created_at', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) { console.error('Error leyendo contacts:', error.message); process.exit(1); }
    if (!data || data.length === 0) break;
    all.push(...(data as Contact[]));
    if (data.length < PAGE) break;
  }
  console.log(`Contactos totales: ${all.length}`);

  // Candidatos: con name y sin casino_username.
  const targets = all.filter((c) => !isEmpty(c.name) && isEmpty(c.casino_username));
  console.log(`A actualizar (name → casino_username): ${targets.length}\n`);

  for (const c of targets.slice(0, 25)) {
    console.log(`  ${c.id}  casino_username = ${JSON.stringify(c.name)}`);
  }
  if (targets.length > 25) console.log(`  … y ${targets.length - 25} más`);

  if (!APPLY) {
    console.log('\nDRY-RUN: no se escribió nada. Volvé a correr con --apply para aplicar.\n');
    return;
  }

  let ok = 0, fail = 0;
  for (const c of targets) {
    // Los candidatos ya fueron filtrados (name presente, casino_username vacío);
    // no se sobreescribe ninguno con casino_username existente.
    const { error } = await supabase
      .from('contacts')
      .update({ casino_username: (c.name ?? '').trim() })
      .eq('id', c.id);
    if (error) { fail++; console.error(`  ✗ ${c.id}: ${error.message}`); }
    else ok++;
  }
  console.log(`\nAPPLY terminado: ${ok} actualizados, ${fail} con error.\n`);
}

main().catch((err) => { console.error('Excepción:', err); process.exit(1); });
