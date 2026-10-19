import { supabaseAdmin } from '@/lib/db';

// Candidatos a "pendiente" (contacto + su último mensaje) para classifyPending.
// Sale de fn_contacts_pending_candidates (supabase-agregados-sin-tope-rpcs.sql),
// que ya descarta en la base los 3 casos en que classifyPending da null de
// entrada (sin mensajes, leído, o el último es de un humano). Reemplaza a
// fn_contacts_pending_snapshot, que devolvía 1 fila por contacto y PostgREST la
// cortaba en 1.000 (Derki: 20.214 contactos → contadores de menos).
//
// Normalmente es una sola página (solo los no leídos); se pagina por las dudas
// con orden estable por id.

export type PendingCandidate = {
  id: string;
  conversation_state: string | null;
  last_read_at: string | null;
  human_taken: boolean | null;
  last_role: string | null;
  last_msg_at: string | null;
};

const PAGE = 1000;

export async function loadPendingCandidates(tenantId: string): Promise<{ rows: PendingCandidate[] } | { error: string }> {
  const rows: PendingCandidate[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabaseAdmin
      .rpc('fn_contacts_pending_candidates', { p_tenant_id: tenantId })
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) return { error: error.message };
    rows.push(...((data ?? []) as PendingCandidate[]));
    if (!data || data.length < PAGE) break;
  }
  return { rows };
}
