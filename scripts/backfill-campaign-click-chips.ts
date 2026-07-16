/**
 * Backfill de los chips "✅ Apretó: …" de clicks de botón de campaña que quedaron
 * sin insertar por el bug del constraint messages_role_check (ver
 * supabase-message-role-system.sql). GLOBAL: recorre TODAS las campañas.
 *
 * Requiere que la migración del constraint (role='system') ya esté aplicada.
 *
 * Uso:
 *   node --env-file=../.env.local --experimental-strip-types scripts/backfill-campaign-click-chips.ts            # dry-run
 *   node --env-file=../.env.local --experimental-strip-types scripts/backfill-campaign-click-chips.ts --commit   # escribe
 *
 * Idempotente: por cada contacto salta el insert si ya existe un campaign_event
 * con el mismo payload. Fija created_at al mejor proxy del momento del click
 * (read_at ?? delivered_at ?? created_at) para que el chip caiga en su lugar
 * cronológico. Inserta directo (no vía insertMessage) para poder fijar created_at
 * y no disparar Broadcasts de algo histórico.
 */
import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error('Faltan env vars. Corré con --env-file=.env.local'); process.exit(1); }
const supabase = createClient(url, key, { auth: { persistSession: false } });

const COMMIT = process.argv.includes('--commit');

async function main() {
  // Todas las filas con click registrado (btn_payload) que tengan contacto, de
  // cualquier campaña. Paginado por si son muchas.
  const clicks: any[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('campaign_message_status')
      .select('campaign_id, contact_id, tenant_id, btn_payload, btn_text, created_at, delivered_at, read_at')
      .not('btn_payload', 'is', null)
      .not('contact_id', 'is', null)
      .order('created_at', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) { console.error('Error leyendo campaign_message_status:', error.message); process.exit(1); }
    if (!data || data.length === 0) break;
    clicks.push(...data);
    if (data.length < PAGE) break;
  }

  console.log(`Clicks con btn_payload (todas las campañas): ${clicks.length}`);
  console.log(`Modo: ${COMMIT ? 'COMMIT (escribe)' : 'DRY-RUN (no escribe)'}\n`);

  let inserted = 0, skipped = 0, errored = 0;
  for (const c of clicks) {
    // Idempotencia: ¿ya hay un chip campaign_event con este payload para el contacto?
    const { data: existing, error: exErr } = await supabase
      .from('messages')
      .select('id, content')
      .eq('contact_id', c.contact_id)
      .eq('role', 'system');
    if (exErr) { console.error(`  ERROR leyendo messages contact=${c.contact_id}: ${exErr.message}`); errored++; continue; }
    const dupe = (existing ?? []).some((m) => {
      try { const p = JSON.parse(m.content); return p?._type === 'campaign_event' && p?.payload === c.btn_payload; }
      catch { return false; }
    });
    if (dupe) { skipped++; console.log(`skip (ya existe)  contact=${c.contact_id} payload=${c.btn_payload}`); continue; }

    const ts = c.read_at ?? c.delivered_at ?? c.created_at; // proxy del momento del click
    const row = {
      contact_id: c.contact_id,
      role:       'system',
      tenant_id:  c.tenant_id,
      created_at: ts,
      content:    JSON.stringify({ _type: 'campaign_event', text: c.btn_text || null, payload: c.btn_payload }),
    };
    console.log(`${COMMIT ? 'INSERT' : 'DRY   '}  contact=${c.contact_id} payload=${c.btn_payload} text=${JSON.stringify(c.btn_text)} ts=${ts} campaign=${c.campaign_id}`);
    if (COMMIT) {
      const { error: iErr } = await supabase.from('messages').insert(row);
      if (iErr) { console.error(`  ERROR insertando: ${iErr.message}`); errored++; continue; }
    }
    inserted++;
  }

  console.log(`\n${COMMIT ? 'Insertados' : 'A insertar (dry-run)'}: ${inserted} | saltados (ya existían): ${skipped} | errores: ${errored}`);
}
main().then(() => process.exit(0));
