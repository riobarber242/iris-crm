/**
 * Backfill de nombres en contactos "desconocidos".
 *
 * Una "conversación" en IRIS es un row de `contacts` + sus mensajes; el nombre
 * que se muestra es `contacts.name`. Como `phone` es UNIQUE, los duplicados
 * existen solo con formatos distintos del mismo número (549..., +549..., 54...).
 * Antes del fix de matching por número normalizado, el webhook creaba contactos
 * sin nombre cuando el formato no matcheaba exacto.
 *
 * Este script busca contactos con name null / vacío / "desconocido" cuyo número
 * (normalizado al "core" nacional) coincide con OTRO contacto que sí tiene
 * nombre, y les copia ese nombre. NO borra ni fusiona nada — solo rellena names.
 *
 * Uso:
 *   node --env-file=.env.local scripts/backfill-contact-names.ts          # dry-run
 *   node --env-file=.env.local scripts/backfill-contact-names.ts --apply  # aplica
 */
import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  console.error('Faltan NEXT_PUBLIC_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY. Corré con --env-file=.env.local');
  process.exit(1);
}

const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });

const APPLY = process.argv.includes('--apply');

// Mismo "core" que findOrCreateContact en src/lib/meta/handler.ts.
function phoneCore(raw: string): string {
  let d = (raw ?? '').replace(/\D/g, '');
  if (d.startsWith('54')) d = d.slice(2);
  if (d.startsWith('9') && d.length > 10) d = d.slice(1);
  return d;
}

function isNameless(name: string | null | undefined): boolean {
  if (!name) return true;
  const t = name.trim().toLowerCase();
  return t === '' || t === 'desconocido';
}

type Contact = { id: string; phone: string; name: string | null; casino_username: string | null; created_at: string };

async function main() {
  console.log(`\n=== Backfill de nombres de contactos — modo ${APPLY ? 'APPLY (escribe)' : 'DRY-RUN (no escribe)'} ===\n`);

  // 1. Traer todos los contactos (paginado para no cortar en 1000).
  const all: Contact[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('contacts')
      .select('id, phone, name, casino_username, created_at')
      .order('created_at', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) { console.error('Error leyendo contacts:', error.message); process.exit(1); }
    if (!data || data.length === 0) break;
    all.push(...(data as Contact[]));
    if (data.length < PAGE) break;
  }
  console.log(`Contactos totales: ${all.length}`);

  // 2. Agrupar por core normalizado.
  const groups = new Map<string, Contact[]>();
  for (const c of all) {
    const core = phoneCore(c.phone);
    if (core.length < 8) continue; // núcleo demasiado corto → no agrupar
    const arr = groups.get(core) ?? [];
    arr.push(c);
    groups.set(core, arr);
  }

  // 3. Por cada grupo con un nombre disponible, rellenar los sin nombre.
  const updates: { id: string; phone: string; from: string | null; to: string }[] = [];
  let ambiguous = 0;

  for (const [, members] of groups) {
    const named   = members.filter((m) => !isNameless(m.name));
    const nameless = members.filter((m) => isNameless(m.name));
    if (named.length === 0 || nameless.length === 0) continue;

    // Donante: el contacto con nombre más antiguo (el "original"). Si hay varios
    // nombres distintos, se elige igual el más antiguo y se cuenta como ambiguo.
    const distinctNames = new Set(named.map((m) => (m.name ?? '').trim()));
    if (distinctNames.size > 1) ambiguous++;
    const donor = named.slice().sort((a, b) => a.created_at.localeCompare(b.created_at))[0];

    for (const target of nameless) {
      updates.push({ id: target.id, phone: target.phone, from: target.name, to: donor.name as string });
    }
  }

  console.log(`Grupos con duplicados resolubles: ${updates.length} contacto(s) sin nombre a rellenar`);
  if (ambiguous > 0) console.log(`⚠ ${ambiguous} grupo(s) con nombres distintos — se usó el más antiguo.`);

  // 4. Muestra.
  const sample = updates.slice(0, 20);
  for (const u of sample) {
    console.log(`  ${u.phone}  name=${JSON.stringify(u.from)} → ${JSON.stringify(u.to)}`);
  }
  if (updates.length > sample.length) console.log(`  … y ${updates.length - sample.length} más`);

  if (!APPLY) {
    console.log('\nDRY-RUN: no se escribió nada. Volvé a correr con --apply para aplicar.\n');
    return;
  }

  // 5. Aplicar.
  let ok = 0, fail = 0;
  for (const u of updates) {
    const { error } = await supabase.from('contacts').update({ name: u.to }).eq('id', u.id);
    if (error) { fail++; console.error(`  ✗ ${u.phone}: ${error.message}`); }
    else ok++;
  }
  console.log(`\nAPPLY terminado: ${ok} actualizados, ${fail} con error.\n`);
}

main().catch((err) => { console.error('Excepción:', err); process.exit(1); });
