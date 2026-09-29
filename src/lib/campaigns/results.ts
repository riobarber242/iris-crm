import { supabaseAdmin } from '@/lib/db';
import { isMissingTable, phoneKey } from '@/lib/campaigns/optouts';

// Resultados por contacto de UNA campaña (quién tocó qué botón, quién falló y por
// qué) + qué se puede limpiar. Lo usan el listado (GET /api/campaigns/[id]/results)
// y la acción (POST /api/campaigns/[id]/cleanup): que salgan de la MISMA función es
// el punto — el número que confirma el operador es el que se procesa.

const IN_CHUNK = 200;
const PAGE = 1000;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ── Clasificación de fallos ──────────────────────────────────────────────────
//  invalido    → el NÚMERO no puede recibir (131026). Candidato a limpiar.
//  contacto_ok → Meta frenó ESE envío pero el contacto está bien (tope de marketing
//                por persona, experimento, demasiados mensajes seguidos, ventana).
//  cuenta      → problema de la cuenta/plantilla/config (pago, restricción por país,
//                token, plantilla, calidad) o sin código. Nada que hacer con el
//                contacto: se arregla en Meta Business.
export type FailureClass = 'invalido' | 'contacto_ok' | 'cuenta';

const CONTACTO_OK = new Set([131049, 130472, 131056, 131047]);

export function failureClass(code: number | null | undefined): FailureClass {
  if (code === 131026) return 'invalido';
  if (code != null && CONTACTO_OK.has(code)) return 'contacto_ok';
  return 'cuenta';
}

// ── Botones de la campaña ────────────────────────────────────────────────────
// La POSICIÓN manda (mismo criterio que el auto-enganche): el primero es el
// positivo y el último el negativo, sin importar el texto.
export type ButtonRole = 'positivo' | 'negativo' | 'medio';
export type ButtonInfo = { index: number; label: string; role: ButtonRole };

export function buttonRole(index: number, total: number): ButtonRole {
  if (index === 0) return 'positivo';
  if (index === total - 1) return 'negativo';
  return 'medio';
}

// Labels de los botones de la plantilla de cada campaña. Keyeado por
// (name, language) con la primera fila, igual que send-core y el auto-enganche.
export async function templateButtonsFor(
  tenantId: string,
  campaigns: { template_name?: string | null; template_language?: string | null }[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const names = Array.from(new Set(campaigns.map((c) => c.template_name).filter(Boolean))) as string[];
  if (names.length === 0) return out;
  const { data } = await supabaseAdmin
    .from('whatsapp_templates')
    .select('name, language, buttons')
    .eq('tenant_id', tenantId)
    .in('name', names);
  for (const t of data ?? []) {
    const key = `${t.name}|${t.language ?? 'es'}`;
    if (!out.has(key) && Array.isArray(t.buttons)) out.set(key, t.buttons.filter((b: unknown) => typeof b === 'string'));
  }
  return out;
}

export function templateKey(c: { template_name?: string | null; template_language?: string | null }): string {
  return `${c.template_name ?? ''}|${c.template_language ?? 'es'}`;
}

// ── Resultado por contacto ───────────────────────────────────────────────────
export type Activity = { kind: 'mensaje' | 'carga'; at: string };

export type ResultRow = {
  contact_id:      string | null;
  phone:           string | null;
  name:            string | null;
  casino_username: string | null;
  kind:            'boton' | 'fallido';
  btn_index:       number | null;
  btn_text:        string | null;
  error_code:      number | null;
  failure_class:   FailureClass | null;
  sent_at:         string;
  // Actividad del contacto POSTERIOR al envío (mensaje entrante o carga
  // verificada). Solo se calcula para los candidatos a limpieza.
  activity:        Activity | null;
  opted_out:       boolean;
  deleted:         boolean;          // el contacto ya no existe
  fail_count:      number | null;    // veces que falló con 131026 (cualquier campaña)
};

export type CleanupGroup = 'negativo' | 'invalido';

export type CampaignResults = {
  buttons: ButtonInfo[];
  rows:    ResultRow[];
};

// ¿La fila entra en la limpieza de `group`? Excluye a los que volvieron a estar
// activos y a los contactos que ya no existen (no hay nada que marcar ni borrar).
// Un contacto borrado deja contact_id en NULL (FK ON DELETE SET NULL, ver
// supabase-cms-contact-fk.sql). loadCampaignResults igual chequea que el contacto
// exista en vez de confiar solo en el null: cubre también cualquier id colgando de
// antes de esa FK.
export function inCleanupGroup(r: ResultRow, group: CleanupGroup, buttons: ButtonInfo[]): boolean {
  if (r.deleted || !r.contact_id || r.activity) return false;
  if (group === 'invalido') return r.kind === 'fallido' && r.failure_class === 'invalido';
  const neg = buttons.find((b) => b.role === 'negativo');
  return r.kind === 'boton' && !!neg && r.btn_index === neg.index;
}

export async function loadCampaignResults(
  tenantId: string,
  campaign: { id: string; template_name?: string | null; template_language?: string | null },
): Promise<CampaignResults | { error: string }> {
  // 1) Filas de tracking con click o con fallo (las que no tienen ni una ni otra
  //    no pertenecen a ningún grupo accionable).
  const cms: any[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabaseAdmin
      .from('campaign_message_status')
      .select('id, contact_id, phone, status, btn_payload, btn_text, error_code, created_at')
      .eq('tenant_id', tenantId)
      .eq('campaign_id', campaign.id)
      .or('btn_payload.not.is.null,status.eq.failed')
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) return { error: error.message };
    cms.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }

  // 2) Botones: de la plantilla; si ya no existe, se infiere de los clicks vistos
  //    (mínimo 2, así el último observado no pasa a ser "negativo" por accidente
  //    cuando solo hubo clicks en el primero).
  const tplMap = await templateButtonsFor(tenantId, [campaign]);
  let labels = tplMap.get(templateKey(campaign)) ?? [];
  if (labels.length === 0) {
    const seen = new Map<number, string>();
    for (const r of cms) {
      const idx = btnIndex(r.btn_payload);
      if (idx != null && !seen.has(idx)) seen.set(idx, r.btn_text ?? `Botón ${idx + 1}`);
    }
    const n = Math.max(2, ...Array.from(seen.keys()).map((i) => i + 1));
    labels = Array.from({ length: n }, (_, i) => seen.get(i) ?? `Botón ${i + 1}`);
  }
  const buttons: ButtonInfo[] = labels.map((label, index) => ({ index, label, role: buttonRole(index, labels.length) }));

  // 3) Datos vivos de los contactos.
  const contactIds = Array.from(new Set(cms.map((r) => r.contact_id).filter(Boolean))) as string[];
  const contacts = new Map<string, { name: string | null; phone: string | null; casino_username: string | null }>();
  for (const ids of chunk(contactIds, IN_CHUNK)) {
    const { data, error } = await supabaseAdmin
      .from('contacts').select('id, name, phone, casino_username')
      .eq('tenant_id', tenantId).in('id', ids);
    if (error) return { error: error.message };
    for (const c of data ?? []) contacts.set(c.id, c);
  }

  const rows: ResultRow[] = cms.map((r) => {
    const c = r.contact_id ? contacts.get(r.contact_id) : undefined;
    const failed = r.status === 'failed';
    return {
      contact_id:      c ? r.contact_id : null,
      phone:           c?.phone ?? r.phone ?? null,
      name:            c?.name ?? null,
      casino_username: c?.casino_username ?? null,
      kind:            failed ? 'fallido' : 'boton',
      btn_index:       failed ? null : btnIndex(r.btn_payload),
      btn_text:        failed ? null : (r.btn_text ?? null),
      error_code:      failed ? (r.error_code ?? null) : null,
      failure_class:   failed ? failureClass(r.error_code) : null,
      sent_at:         r.created_at,
      activity:        null,
      opted_out:       false,
      deleted:         !c,
      fail_count:      null,
    };
  });

  // 4) "No molestar" ya marcado (por teléfono).
  const keys = Array.from(new Set(rows.map((r) => phoneKey(r.phone)).filter(Boolean)));
  const opted = new Set<string>();
  for (const ks of chunk(keys, IN_CHUNK)) {
    const { data, error } = await supabaseAdmin
      .from('contact_optouts').select('phone').eq('tenant_id', tenantId).in('phone', ks);
    if (error) {
      if (isMissingTable(error)) break;
      return { error: error.message };
    }
    for (const o of data ?? []) opted.add(o.phone);
  }
  for (const r of rows) r.opted_out = opted.has(phoneKey(r.phone));

  // 5) Actividad posterior, SOLO para candidatos (negativo o número inválido):
  //    para el resto no cambia nada y serían miles de consultas de más.
  const negIdx = buttons.find((b) => b.role === 'negativo')?.index;
  const candidates = rows.filter((r) => r.contact_id && (
    (r.kind === 'boton' && r.btn_index === negIdx) || r.failure_class === 'invalido'
  ));
  const since = new Map<string, string>();
  for (const r of candidates) {
    const prev = since.get(r.contact_id!);
    if (!prev || r.sent_at < prev) since.set(r.contact_id!, r.sent_at);
  }
  const ids = Array.from(since.keys());
  if (ids.length > 0) {
    const minSince = Array.from(since.values()).sort()[0];
    const latest = new Map<string, Activity>();
    const bump = (id: string, a: Activity) => {
      const cur = latest.get(id);
      if (!cur || a.at > cur.at) latest.set(id, a);
    };
    for (const slice of chunk(ids, IN_CHUNK)) {
      const [msgs, comps] = await Promise.all([
        fetchAll((f, t) => supabaseAdmin
          .from('messages').select('contact_id, created_at')
          .eq('tenant_id', tenantId).in('contact_id', slice).eq('role', 'user').gt('created_at', minSince)
          .order('created_at', { ascending: true }).range(f, t)),
        fetchAll((f, t) => supabaseAdmin
          .from('comprobantes').select('contact_id, created_at')
          .eq('tenant_id', tenantId).in('contact_id', slice).eq('estado', 'verificado').gt('created_at', minSince)
          .order('created_at', { ascending: true }).range(f, t)),
      ]);
      if ('error' in msgs)  return { error: msgs.error };
      if ('error' in comps) return { error: comps.error };
      for (const m of msgs.rows)  if (m.created_at > since.get(m.contact_id)!) bump(m.contact_id, { kind: 'mensaje', at: m.created_at });
      // La carga pesa más que el mensaje: si hay las dos, se muestra la carga.
      for (const c of comps.rows) if (c.created_at > since.get(c.contact_id)!) {
        const cur = latest.get(c.contact_id);
        if (!cur || cur.kind !== 'carga' || c.created_at > cur.at) latest.set(c.contact_id, { kind: 'carga', at: c.created_at });
      }
    }
    for (const r of candidates) r.activity = latest.get(r.contact_id!) ?? null;
  }

  // 6) Cuántas veces falló con 131026 cada número inválido, en cualquier campaña.
  const invalidIds = Array.from(new Set(rows.filter((r) => r.failure_class === 'invalido' && r.contact_id).map((r) => r.contact_id!)));
  const failCounts = new Map<string, number>();
  for (const slice of chunk(invalidIds, IN_CHUNK)) {
    const res = await fetchAll((f, t) => supabaseAdmin
      .from('campaign_message_status').select('contact_id')
      .eq('tenant_id', tenantId).eq('error_code', 131026).in('contact_id', slice)
      .order('id', { ascending: true }).range(f, t));
    if ('error' in res) return { error: res.error };
    for (const x of res.rows) failCounts.set(x.contact_id, (failCounts.get(x.contact_id) ?? 0) + 1);
  }
  for (const r of rows) if (r.failure_class === 'invalido' && r.contact_id) r.fail_count = failCounts.get(r.contact_id) ?? 1;

  return { buttons, rows };
}

function btnIndex(payload: string | null | undefined): number | null {
  const m = /^btn_(\d+)$/.exec(payload ?? '');
  return m ? Number(m[1]) : null;
}

async function fetchAll(
  q: (from: number, to: number) => PromiseLike<{ data: any[] | null; error: { message: string } | null }>,
): Promise<{ rows: any[] } | { error: string }> {
  const rows: any[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await q(from, from + PAGE - 1);
    if (error) return { error: error.message };
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return { rows };
}
