import { supabaseAdmin } from '@/lib/db';
import { isMissingTable, phoneKey } from '@/lib/campaigns/optouts';

// "No molestar" DENTRO de una audiencia de campaña, para que el asistente muestre
// cuántos (y quiénes) va a descartar el envío. Misma regla que send-core: match
// por teléfono contra contact_optouts del MISMO tenant. Lo que se cuenta son
// CONTACTOS (la unidad que se envía), no marcas: una marca de un número ya
// borrado no suma.
//
// Aislamiento: el tenant es siempre el de la sesión (lo pasa la ruta) y se aplica
// tanto a contact_optouts como a la query de contactos que arma `build`.

export type AudienceBuilder = (cols: string, opts?: { count: 'exact'; head: true }) => any;

export type ExcludedContact = {
  id: string;
  name: string | null;
  phone: string;
  casino_username: string | null;
  reason: string | null;
  opted_out_at: string | null;
};

// Tope de la lista que se muestra en el asistente (el COUNT es siempre exacto).
export const EXCLUDED_LIST_MAX = 500;

// Teléfonos por lote del `.in('phone')`: cada uno va en 2 variantes (con y sin
// '+'), así que 100 → 200 valores, el mismo largo de URL que IN_CHUNK.
const PHONES_PER_CHUNK = 100;

type OptOutMark = { reason: string | null; created_at: string | null };

async function loadMarks(tenantId: string): Promise<{ marks: Map<string, OptOutMark> } | { error: string }> {
  const marks = new Map<string, OptOutMark>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabaseAdmin
      .from('contact_optouts')
      .select('phone, reason, created_at')
      .eq('tenant_id', tenantId)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      if (isMissingTable(error)) return { marks };
      return { error: error.message };
    }
    for (const r of data ?? []) marks.set(r.phone, { reason: r.reason ?? null, created_at: r.created_at ?? null });
    if (!data || data.length < PAGE) break;
  }
  return { marks };
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// contacts.phone hoy es solo dígitos, pero el alta manual/import pudieron traer '+'.
const variants = (keys: string[]) => keys.flatMap((k) => [k, `+${k}`]);

// Cuántos contactos de la audiencia están en "no molestar". Conteo en la base
// (head:true), sin traer filas.
export async function countAudienceOptOuts(tenantId: string, build: AudienceBuilder): Promise<{ excluded: number } | { error: string }> {
  const m = await loadMarks(tenantId);
  if ('error' in m) return m;
  if (m.marks.size === 0) return { excluded: 0 };
  let excluded = 0;
  for (const keys of chunk(Array.from(m.marks.keys()), PHONES_PER_CHUNK)) {
    const { count, error } = await build('id', { count: 'exact', head: true }).in('phone', variants(keys));
    if (error) return { error: error.message };
    excluded += count ?? 0;
  }
  return { excluded };
}

// Lista (acotada a EXCLUDED_LIST_MAX) de los contactos de la audiencia en "no
// molestar", con el motivo y la fecha de la marca.
export async function listAudienceOptOuts(tenantId: string, build: AudienceBuilder): Promise<{ contacts: ExcludedContact[] } | { error: string }> {
  const m = await loadMarks(tenantId);
  if ('error' in m) return m;
  const contacts: ExcludedContact[] = [];
  for (const keys of chunk(Array.from(m.marks.keys()), PHONES_PER_CHUNK)) {
    if (contacts.length >= EXCLUDED_LIST_MAX) break;
    const { data, error } = await build('id, name, phone, casino_username')
      .in('phone', variants(keys))
      .order('id', { ascending: true })
      .range(0, EXCLUDED_LIST_MAX - contacts.length - 1);
    if (error) return { error: error.message };
    for (const c of data ?? []) {
      const mark = m.marks.get(phoneKey(c.phone));
      contacts.push({ ...c, reason: mark?.reason ?? null, opted_out_at: mark?.created_at ?? null });
    }
  }
  contacts.sort((a, b) => (a.casino_username || a.name || a.phone).localeCompare(b.casino_username || b.name || b.phone));
  return { contacts };
}

// ¿Cuáles de estos teléfonos están en "no molestar"? (para marcar una página del
// selector de contactos). Devuelve claves phoneKey.
export async function optedOutAmong(tenantId: string, phones: (string | null | undefined)[]): Promise<Set<string>> {
  const keys = Array.from(new Set(phones.map(phoneKey).filter(Boolean)));
  const out = new Set<string>();
  for (const ks of chunk(keys, 200)) {
    const { data, error } = await supabaseAdmin
      .from('contact_optouts').select('phone').eq('tenant_id', tenantId).in('phone', ks);
    if (error) {
      if (isMissingTable(error)) break;
      // Best-effort: es solo la marca visual; el envío igual los excluye.
      console.warn('[optouts] No se pudo marcar la página del selector:', error.message);
      break;
    }
    for (const o of data ?? []) out.add(o.phone);
  }
  return out;
}
