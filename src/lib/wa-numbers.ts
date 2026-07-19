import { supabaseAdmin } from '@/lib/db';

// Cupo de números de WhatsApp por tenant. Regla ÚNICA compartida por el alta
// self-service (/api/whatsapp-numbers) y el alta admin
// (/api/tenants/[id]/whatsapp-numbers) para que no se desincronicen.
//
// Cuenta TODAS las filas del tenant (activas + inactivas): cada phone_number_id
// ocupa lugar aunque esté desactivado. El tope sale de tenants.max_whatsapp_numbers
// (default 2 si la fila no lo tuviera).
export async function numbersQuota(tenantId: string): Promise<{ count: number; max: number; full: boolean }> {
  const { count } = await supabaseAdmin
    .from('whatsapp_numbers')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId);

  const { data: t } = await supabaseAdmin
    .from('tenants')
    .select('max_whatsapp_numbers')
    .eq('id', tenantId)
    .maybeSingle();

  const max = t?.max_whatsapp_numbers ?? 2;
  const c = count ?? 0;
  return { count: c, max, full: c >= max };
}
