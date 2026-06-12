import { supabaseAdmin } from './db';

// Configuración del bot de WhatsApp por tenant (tabla settings, key-value).
// Compartido entre el webhook (handler.ts) y las herramientas de Iris AI.

export const DEFAULT_OFFLINE_MSG = 'Hola! En este momento no estamos operando. Volvemos pronto 🙏';

// Mismo límite que /api/agent/config y BotConfigEditor.
export const SYSTEM_PROMPT_MAX_LEN = 4000;

export async function getTenantSetting(tenantId: string, key: string): Promise<string | null> {
  try {
    const { data } = await supabaseAdmin
      .from('settings')
      .select('value')
      .eq('key', key)
      .eq('tenant_id', tenantId)
      .limit(1)
      .maybeSingle();
    return data?.value ?? null;
  } catch {
    return null;
  }
}

// settings tiene unicidad por (key, tenant_id) → se reemplaza la fila del
// tenant (mismo patrón que /api/agent/config). Devuelve el error o null si ok.
export async function setTenantSetting(tenantId: string, key: string, value: string): Promise<string | null> {
  await supabaseAdmin.from('settings').delete().eq('key', key).eq('tenant_id', tenantId);
  const { error } = await supabaseAdmin
    .from('settings')
    .insert({ key, value, tenant_id: tenantId });
  return error?.message ?? null;
}

export async function getOfflineMsg(tenantId: string): Promise<string> {
  const v = await getTenantSetting(tenantId, 'offline_msg');
  return v && v.trim() ? v : DEFAULT_OFFLINE_MSG;
}

// Reglas de negocio para TEXTOS QUE VE EL CLIENTE (ej: mensaje de offline):
// jamás la palabra "casino" ni promesas de premios/ganancias garantizadas.
// NO aplicar al system_prompt: es texto interno que el cliente nunca ve y
// NECESITA mencionar esas palabras justamente para prohibirlas ("Nunca usás
// palabras como casino..."). Devuelve el motivo del rechazo o null si es válido.
export function validateBotText(text: string): string | null {
  if (/casino/i.test(text)) {
    return 'contiene la palabra "casino" (usar términos neutros: recarga, saldo, plataforma)';
  }
  const promesas = [
    /(premios?|ganancias?|plata|dinero|retiros?)\s+(100%\s+)?(garantizad|asegurad)/i,
    /(garantiz|asegur)\w*\s+(que\s+)?(gan[áa]s|ganar|premios?|ganancias?)/i,
    /ganancias?\s+seguras?/i,
    /premios?\s+seguros?/i,
    /siempre\s+gan[áa]s/i,
  ];
  if (promesas.some((re) => re.test(text))) {
    return 'promete premios o ganancias garantizadas';
  }
  return null;
}
