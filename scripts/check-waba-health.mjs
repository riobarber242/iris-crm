/**
 * Chequeo READ-ONLY de elegibilidad/salud de una WABA vía Graph API (health_status).
 * Sirve para confirmar si una cuenta volvió a estar habilitada para enviar —p.ej.
 * después de resolver un cobro fallido (error 131042)— SIN tener que mandar un
 * mensaje real y esperar a ver si falla.
 *
 * Uso:  node --env-file=.env.local scripts/check-waba-health.mjs [tenant_id]
 *   · sin arg → Casino 17Star (default).
 *   · No escribe nada. No manda mensajes.
 *
 * Nota de credenciales: usa el token GLOBAL de env (WHATSAPP_ACCESS_TOKEN). Vale para
 * las líneas que NO tienen token propio (el caso de 17Star). Para una línea con token
 * propio cifrado, health_status habría que pedirlo con ese token (no cubierto acá).
 *
 * Límite conocido: este token NO es de un BSP, así que los campos de FACTURACIÓN de la
 * WABA (account_review_status, primary_funding_id, método de pago) devuelven code 10
 * (permiso). health_status sí trae can_send_message + motivos por entidad, que es lo
 * más cercano a "¿puedo enviar y por qué no?".
 */
import { createClient } from '@supabase/supabase-js';

const TENANT_DEFAULT = 'f56fdb7c-cf5c-45df-854f-cd040fdd3b95'; // Casino 17Star
const BASE  = 'https://graph.facebook.com/v21.0';
const TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const URL   = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!TOKEN) { console.error('Falta WHATSAPP_ACCESS_TOKEN (corré con --env-file=.env.local)'); process.exit(1); }
if (!URL || !KEY) { console.error('Faltan credenciales de Supabase (--env-file=.env.local)'); process.exit(1); }

const tenantId = process.argv[2] || TENANT_DEFAULT;
const sb = createClient(URL, KEY, { auth: { persistSession: false } });
const L = (s = '') => console.log(s);

// Palabras que delatan un motivo de PAGO/FACTURACIÓN en el texto de Meta.
const PAYMENT_RE = /payment|billing|pago|facturaci|funding|fondos|eligibility|elegib|credit|tarjeta/i;

async function graph(id, fields) {
  try {
    const r = await fetch(`${BASE}/${id}?fields=${fields}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    return { status: r.status, j: await r.json() };
  } catch (e) { return { status: 0, j: { error: { message: String(e) } } }; }
}

// Aplana los motivos (additional_info + errors) de una entidad de health_status.
function reasonsOf(entity) {
  const out = [];
  for (const a of entity.additional_info ?? []) out.push(String(a));
  for (const e of entity.errors ?? []) out.push(`[${e.error_code}] ${e.error_description ?? e.error_title ?? ''}`);
  return out;
}

async function main() {
  const nowAR = new Date(Date.now() - 180 * 60000).toISOString().slice(0, 16).replace('T', ' ');
  L(`Chequeo de salud WABA — ${nowAR} AR — tenant ${tenantId}\n`);

  const { data: nums, error } = await sb
    .from('whatsapp_numbers')
    .select('id, label, phone_number_id, waba_id')
    .eq('tenant_id', tenantId);
  if (error) { console.error('Error leyendo whatsapp_numbers:', error.message); process.exit(1); }
  if (!nums || !nums.length) { L('El tenant no tiene líneas cargadas.'); return; }

  let anyPaymentBlock = false;
  let anyBlocked = false;

  for (const n of nums) {
    L(`━━━ ${n.label} (${n.phone_number_id}) ━━━`);
    const { status, j } = await graph(n.phone_number_id, 'health_status,quality_rating,messaging_limit_tier,name_status');
    if (j.error) { L(`  ⚠ Error Graph ${status}: [${j.error.code}] ${j.error.message}\n`); continue; }

    L(`  calidad=${j.quality_rating ?? '-'}  ·  tier=${j.messaging_limit_tier ?? '-'}  ·  display_name=${j.name_status ?? '-'}`);
    const hs = j.health_status;
    if (!hs) { L(`  (sin health_status)\n`); continue; }

    const global = hs.can_send_message;
    L(`  can_send_message (global): ${global}`);
    if (global === 'BLOCKED') anyBlocked = true;

    let paymentReasonHere = false;
    for (const e of hs.entities ?? []) {
      const reasons = reasonsOf(e);
      const pay = reasons.some((r) => PAYMENT_RE.test(r));
      if (pay) { paymentReasonHere = true; anyPaymentBlock = true; }
      const tag = e.can_send_message === 'AVAILABLE' ? '✅' : e.can_send_message === 'BLOCKED' ? '⛔' : '⚠️';
      L(`    ${tag} ${e.entity_type}: ${e.can_send_message}${pay ? '   ← MENCIONA PAGO/FACTURACIÓN' : ''}`);
      for (const r of reasons) L(`         · ${r}`);
    }
    L(`  → ${paymentReasonHere ? '⛔ Hay un motivo de PAGO/FACTURACIÓN activo en esta línea.' : '✔ Sin motivo de pago/facturación visible en esta línea.'}\n`);
  }

  // ── Veredicto ────────────────────────────────────────────────────────────────
  L('════════════════ VEREDICTO ════════════════');
  if (anyPaymentBlock) {
    L('⛔ TODAVÍA HAY UN BLOQUEO DE PAGO/FACTURACIÓN. El pago aún no se reflejó como resuelto.');
  } else if (anyBlocked) {
    L('⛔ La cuenta está BLOQUEADA, pero por un motivo NO relacionado a pago (ver arriba).');
  } else {
    L('✔ NO se ve ningún motivo de PAGO/FACTURACIÓN. El bloqueo de pago (131042) parece resuelto.');
    L('   Puede seguir en LIMITED por causas permanentes (verificación de negocio / display name),');
    L('   que limitan el volumen pero NO son el bloqueo de pago.');
  }
  L('');
  L('OJO: este token no lee los campos de facturación de la WABA (permiso de BSP), así que');
  L('esto es indirecto. Confirmación definitiva: además de este verde, un envío de PRUEBA (1-2');
  L('mensajes) que NO devuelva webhook 131042. El panel ya muestra el 131042 traducido si reaparece.');
}

main().catch((e) => { console.error('EX', e); process.exit(1); });
