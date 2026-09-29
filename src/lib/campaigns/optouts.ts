import { supabaseAdmin } from '@/lib/db';

// "No molestar" persistente por teléfono (tabla contact_optouts, ver
// supabase-contact-optouts.sql). Es por TELÉFONO y no por contact_id a propósito:
// tiene que sobrevivir al borrado del contacto y a un re-import del mismo número.
// Solo excluye de campañas; el bot y el chat 1 a 1 no lo miran.

export type OptOutReason = 'boton_negativo' | 'numero_invalido' | 'manual';

// Clave de matcheo: solo dígitos. contacts.phone viene sin '+' desde el webhook,
// pero el alta manual y el import pueden traerlo con '+' o separadores.
export function phoneKey(raw: string | null | undefined): string {
  return String(raw ?? '').replace(/\D/g, '');
}

// ¿El error es "la tabla no existe"? (migración todavía sin correr). PostgREST
// devuelve PGRST205 cuando la tabla no está en el schema cache; 42P01 es el de
// Postgres. Cualquier otro error NO es esto y no se debe tratar como "sin opt-outs".
export function isMissingTable(err: { code?: string } | null | undefined): boolean {
  return !!err && (err.code === 'PGRST205' || err.code === '42P01');
}

// Todos los teléfonos con "no molestar" del tenant, como Set de claves.
// Devuelve { error } ante un fallo real para que el que llama decida (el envío de
// campaña NO debe seguir como si no hubiera opt-outs: mandaría a gente que pidió
// que no). Tabla inexistente = set vacío con aviso (migración pendiente).
export async function loadOptedOutPhones(
  tenantId: string,
): Promise<{ phones: Set<string> } | { error: string }> {
  const phones = new Set<string>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabaseAdmin
      .from('contact_optouts')
      .select('phone')
      .eq('tenant_id', tenantId)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      if (isMissingTable(error)) {
        console.warn('[optouts] Tabla contact_optouts inexistente (¿migración pendiente?): sin exclusión.');
        return { phones };
      }
      return { error: error.message };
    }
    for (const r of data ?? []) phones.add(r.phone);
    if (!data || data.length < PAGE) break;
  }
  return { phones };
}

// Marca "no molestar" a una lista de teléfonos. Idempotente: si el teléfono ya
// estaba marcado se respeta la marca original (motivo y fecha de la primera vez).
export async function addOptOuts(
  tenantId: string,
  entries: { phone: string | null | undefined }[],
  meta: {
    reason: OptOutReason;
    campaignId?: string | null;
    actorId?: string | null;
    actorName?: string | null;
  },
): Promise<{ error: string | null }> {
  const rows = Array.from(new Set(entries.map((e) => phoneKey(e.phone)).filter((p) => p.length >= 6)))
    .map((phone) => ({
      tenant_id:          tenantId,
      phone,
      reason:             meta.reason,
      source_campaign_id: meta.campaignId ?? null,
      created_by:         meta.actorId ?? null,
      created_by_name:    meta.actorName ?? null,
    }));
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabaseAdmin
      .from('contact_optouts')
      .upsert(rows.slice(i, i + 500), { onConflict: 'tenant_id,phone', ignoreDuplicates: true });
    if (error) return { error: error.message };
  }
  return { error: null };
}
