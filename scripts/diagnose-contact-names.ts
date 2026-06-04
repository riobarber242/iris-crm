/**
 * Diagnóstico READ-ONLY de nombres faltantes en contacts.
 * Uso: node --env-file=.env.local scripts/diagnose-contact-names.ts
 * No escribe nada.
 */
import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) { console.error('Faltan env vars. Corré con --env-file=.env.local'); process.exit(1); }
const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });

const isEmpty = (v: string | null | undefined) => !v || v.trim() === '';

async function main() {
  const all: any[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('contacts')
      .select('id, phone, name, casino_username, ad_source, status, notes, created_at')
      .order('created_at', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) { console.error('Error leyendo contacts:', error.message); process.exit(1); }
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
  }

  const total        = all.length;
  const withPhone    = all.filter((c) => !isEmpty(c.phone));
  const namelessAll  = all.filter((c) => isEmpty(c.name));
  const nameless     = withPhone.filter((c) => isEmpty(c.name));

  const namelessWithCasino  = nameless.filter((c) => !isEmpty(c.casino_username));
  const namelessWithSource  = nameless.filter((c) => !isEmpty(c.ad_source));
  const namelessNothing     = nameless.filter((c) => isEmpty(c.casino_username) && isEmpty(c.ad_source));

  console.log('\n=== DIAGNÓSTICO: nombres faltantes en contacts (READ-ONLY) ===\n');
  console.log(`Total contactos:                         ${total}`);
  console.log(`Con phone:                               ${withPhone.length}`);
  console.log(`name null/vacío (todos):                 ${namelessAll.length}`);
  console.log(`name null/vacío Y con phone:             ${nameless.length}`);
  console.log(`  → de esos, con casino_username:        ${namelessWithCasino.length}`);
  console.log(`  → de esos, con ad_source:              ${namelessWithSource.length}`);
  console.log(`  → de esos, sin nada (solo phone):      ${namelessNothing.length}`);

  console.log('\n--- Muestra: sin nombre PERO con casino_username (posible nombre mal guardado) ---');
  for (const c of namelessWithCasino.slice(0, 25)) {
    console.log(`  phone=${c.phone}  casino_username=${JSON.stringify(c.casino_username)}  ad_source=${JSON.stringify(c.ad_source)}`);
  }
  if (namelessWithCasino.length > 25) console.log(`  … y ${namelessWithCasino.length - 25} más`);

  console.log('\n--- Muestra: sin nombre y sin casino_username ---');
  for (const c of namelessNothing.slice(0, 15)) {
    console.log(`  phone=${c.phone}  ad_source=${JSON.stringify(c.ad_source)}  status=${c.status}`);
  }
  if (namelessNothing.length > 15) console.log(`  … y ${namelessNothing.length - 15} más`);

  const namelessWithNotes = nameless.filter((c) => !isEmpty(c.notes));
  console.log(`\n--- ¿Algún nombre escondido en notes? (${namelessWithNotes.length} de ${nameless.length} sin nombre tienen notes) ---`);
  for (const c of namelessWithNotes.slice(0, 15)) {
    console.log(`  phone=${c.phone}  notes=${JSON.stringify(c.notes)}`);
  }

  console.log(`\n--- LISTA COMPLETA: los ${nameless.length} contactos sin nombre ---`);
  console.log('  #  | phone           | casino_username      | status         | creado');
  nameless
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .forEach((c, i) => {
      const n = String(i + 1).padStart(2, ' ');
      const ph = String(c.phone).padEnd(15, ' ');
      const cu = JSON.stringify(c.casino_username ?? null).padEnd(20, ' ');
      const st = String(c.status ?? '').padEnd(14, ' ');
      const cr = (c.created_at ?? '').slice(0, 10);
      console.log(`  ${n} | ${ph} | ${cu} | ${st} | ${cr}`);
    });
  console.log('');
}

main().catch((e) => { console.error(e); process.exit(1); });
