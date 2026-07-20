import { supabaseAdmin } from '@/lib/db';
import { resolveCreds } from '@/lib/meta/client';

// Resolución de WABA (WhatsApp Business Account) por tenant.
//
// Las plantillas viven en la WABA de cada línea: una plantilla aprobada en la
// WABA A NO existe en la WABA B, y mandarla por un número de B hace que Meta la
// rechace en silencio (error 132001). Por eso todo lo que toca plantillas
// necesita saber de qué WABA está hablando, y este módulo es la única fuente.

export type TenantWaba = {
  wabaId: string;
  token: string;      // token del número que representa a esa WABA (para la Graph API)
  numberIds: string[];  // líneas del tenant que cuelgan de esta WABA
  labels: string[];
};

// WABA "principal" del tenant, con la MISMA prioridad que el resto del proyecto:
// número default activo → columna legacy del tenant → env global. Se usa como
// default cuando el usuario no eligió una línea explícita.
export async function resolveWaba(tenantId: string): Promise<string | null> {
  const { data: num } = await supabaseAdmin
    .from('whatsapp_numbers').select('waba_id')
    .eq('tenant_id', tenantId).eq('is_default', true).eq('active', true).maybeSingle();
  if (num?.waba_id) return num.waba_id;

  const { data: t } = await supabaseAdmin
    .from('tenants').select('whatsapp_waba_id').eq('id', tenantId).maybeSingle();
  if (t?.whatsapp_waba_id) return t.whatsapp_waba_id;

  return process.env.WHATSAPP_BUSINESS_ACCOUNT_ID ?? process.env.WHATSAPP_WABA_ID ?? null;
}

// WABA de UNA línea concreta del tenant (validando que la línea sea suya).
// null = la línea no existe, no es del tenant, o no tiene waba_id cargado.
export async function wabaOfNumber(tenantId: string, numberId: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from('whatsapp_numbers').select('waba_id')
    .eq('id', numberId).eq('tenant_id', tenantId).maybeSingle();
  return data?.waba_id ?? null;
}

// Todas las WABAs distintas del tenant (a partir de sus líneas ACTIVAS con
// waba_id cargado), cada una con un token utilizable para la Graph API.
// Las líneas sin waba_id se ignoran: sin WABA no hay plantillas que consultar.
export async function listTenantWabas(tenantId: string): Promise<TenantWaba[]> {
  const { data } = await supabaseAdmin
    .from('whatsapp_numbers')
    .select('id, label, waba_id, is_default')
    .eq('tenant_id', tenantId)
    .eq('active', true)
    .order('is_default', { ascending: false });

  const byWaba = new Map<string, { numberIds: string[]; labels: string[] }>();
  for (const n of data ?? []) {
    if (!n.waba_id) continue;
    const entry = byWaba.get(n.waba_id) ?? { numberIds: [], labels: [] };
    entry.numberIds.push(n.id);
    entry.labels.push(n.label ?? n.id);
    byWaba.set(n.waba_id, entry);
  }

  // El token se pide por la PRIMERA línea de cada WABA (la default va primera por
  // el order de arriba). resolveCreds cae al token global si la línea no tiene uno.
  const out: TenantWaba[] = [];
  for (const [wabaId, entry] of byWaba) {
    // resolveCreds tira si no hay token propio NI token global en env. Es una
    // WABA que no vamos a poder consultar, pero no puede voltear al que llama
    // (listar plantillas, dar de alta una): la salteamos.
    try {
      const { token } = await resolveCreds(tenantId, entry.numberIds[0]);
      out.push({ wabaId, token, numberIds: entry.numberIds, labels: entry.labels });
    } catch (err) {
      console.warn(`[waba] Sin credenciales para la WABA ${wabaId}, se omite:`, err);
    }
  }
  return out;
}
