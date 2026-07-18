import axios from 'axios';
import { supabaseAdmin } from '../db';
import { readWaSecret } from './wa-secrets';

const BASE_URL = 'https://graph.facebook.com/v21.0';

function getToken(): string {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!token) throw new Error('[WhatsApp] WHATSAPP_ACCESS_TOKEN no configurado en Vercel env vars');
  return token;
}

function getPhoneNumberId(): string {
  const id = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!id) throw new Error('[WhatsApp] WHATSAPP_PHONE_NUMBER_ID no configurado en Vercel env vars');
  return id;
}

// WhatsApp Business Account ID (WABA) — necesario para crear plantillas.
function getBusinessAccountId(): string {
  const id = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID ?? process.env.WHATSAPP_WABA_ID;
  if (!id) throw new Error('[WhatsApp] WHATSAPP_BUSINESS_ACCOUNT_ID no configurado en Vercel env vars');
  return id;
}

// Resuelve las credenciales de WhatsApp a usar para enviar/leer media.
// Siempre como par atómico (nunca token de un origen con phone_id de otro):
//  1. numberId → fila de whatsapp_numbers (el número de ESA conversación).
//     access_token null en la fila = usar el token global de env.
//  2. tenantId → número default activo del tenant en whatsapp_numbers.
//  3. tenantId → columnas legacy tenants.whatsapp_* (números aún no migrados
//     a whatsapp_numbers; retirar cuando se eliminen esas columnas).
//  4. Env vars globales (tenant Principal / sin configuración propia).
export async function resolveCreds(tenantId?: string, numberId?: string | null): Promise<{ token: string; phoneId: string }> {
  try {
    if (numberId) {
      const { data } = await supabaseAdmin
        .from('whatsapp_numbers')
        .select('id, phone_number_id, access_token, access_token_enc')
        .eq('id', numberId)
        .maybeSingle();
      if (data?.phone_number_id) {
        // Lectura dual (cifrado → plano). null = sin token propio → token global.
        const token = readWaSecret(data.access_token_enc, data.access_token, 'access_token', data.id) || getToken();
        return { token, phoneId: data.phone_number_id };
      }
    }
    if (tenantId) {
      const { data: def } = await supabaseAdmin
        .from('whatsapp_numbers')
        .select('id, phone_number_id, access_token, access_token_enc')
        .eq('tenant_id', tenantId)
        .eq('is_default', true)
        .eq('active', true)
        .maybeSingle();
      if (def?.phone_number_id) {
        const token = readWaSecret(def.access_token_enc, def.access_token, 'access_token', def.id) || getToken();
        return { token, phoneId: def.phone_number_id };
      }
      const { data } = await supabaseAdmin
        .from('tenants')
        .select('whatsapp_access_token, whatsapp_phone_id')
        .eq('id', tenantId)
        .maybeSingle();
      if (data?.whatsapp_access_token && data?.whatsapp_phone_id) {
        return { token: data.whatsapp_access_token, phoneId: data.whatsapp_phone_id };
      }
    }
  } catch (err) {
    console.warn('[WhatsApp] resolveCreds falló, uso env globales:', err);
  }
  // Fallback: credenciales globales de env (tenant Principal / sin creds propias).
  return { token: getToken(), phoneId: getPhoneNumberId() };
}

// ── Límite diario de mensajería (messaging limit tier) ───────────────────────
// El límite de Meta es por PORTFOLIO de negocio, compartido por todas las líneas,
// y se cuenta como destinatarios ÚNICOS en una ventana móvil de 24h. Leerlo desde
// UNA línea cualquiera ya devuelve el techo compartido (no se suman líneas).
//
// Meta DEPRECÓ `messaging_limit_tier` a favor de `whatsapp_business_manager_messaging_limit`;
// pedimos el nuevo y, si falla (deploys/versiones viejas), caemos al viejo.
// Devuelve el string del tier (p.ej. "TIER_1K") y su equivalente numérico (o null
// si es ilimitado o no se pudo leer).

// Mapea el tier de Meta a su número de destinatarios/día. null = ilimitado.
export function tierToNumber(tier: string | null | undefined): number | null {
  if (!tier) return null;
  const t = String(tier).toUpperCase();
  if (t.includes('UNLIMITED')) return null;
  const known: Record<string, number> = {
    TIER_50: 50, TIER_250: 250, TIER_500: 500, TIER_1K: 1000,
    TIER_2K: 2000, TIER_10K: 10000, TIER_100K: 100000,
  };
  if (known[t] != null) return known[t];
  // Fallback: parsear TIER_<n>[K] para tiers que Meta agregue en el futuro.
  const m = t.match(/TIER_(\d+)(K)?/);
  if (m) return Number(m[1]) * (m[2] ? 1000 : 1);
  return null;
}

export async function getMessagingLimit(
  tenantId?: string,
  numberId?: string | null,
): Promise<{ tier: string | null; limit: number | null }> {
  const { token, phoneId } = await resolveCreds(tenantId, numberId);
  const headers = { Authorization: `Bearer ${token}` };

  async function read(field: string): Promise<string | null> {
    const { data } = await axios.get(`${BASE_URL}/${phoneId}?fields=${field}`, { headers });
    return (data?.[field] as string | undefined) ?? null;
  }

  try {
    const tier = await read('whatsapp_business_manager_messaging_limit');
    return { tier, limit: tierToNumber(tier) };
  } catch (errNew) {
    // El campo nuevo puede no existir en cuentas/versiones viejas: probamos el viejo.
    try {
      const tier = await read('messaging_limit_tier');
      return { tier, limit: tierToNumber(tier) };
    } catch (errOld) {
      logApiError('getMessagingLimit', errOld);
      return { tier: null, limit: null };
    }
  }
}

function logApiError(context: string, err: any) {
  const status = err?.response?.status;
  const data   = err?.response?.data;
  const msg    = err?.message;
  console.error(
    `[${context}] Error API Facebook: status=${status}`,
    data ? JSON.stringify(data) : msg,
  );
}

// ── Retry ante errores transitorios de Meta ───────────────────────────────────
// Meta a veces responde 500 OAuthException con code 1/2 e is_transient:true
// ("Please retry your request later"): el mismo envío suele funcionar segundos
// después. Errores permanentes (token inválido, ventana de 24h, número
// bloqueado) cortan al primer intento.

const RETRY_DELAYS_MS = [2000, 5000];

function isTransientMetaError(err: any): boolean {
  const status = err?.response?.status;
  const e      = err?.response?.data?.error;
  return e?.is_transient === true || e?.code === 1 || e?.code === 2 || status === 500;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Hasta 3 intentos en total (esperas de 2s y 5s). Corre dentro del webhook en
// Vercel: el peor caso suma ~7s de espera, dentro del tiempo de ejecución de
// la función — NO alargar estas esperas sin revisar ese límite.
export async function withTransientRetry<T>(context: string, fn: () => Promise<T>): Promise<T> {
  const attempts = RETRY_DELAYS_MS.length + 1;
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err: any) {
      if (!isTransientMetaError(err) || i >= RETRY_DELAYS_MS.length) throw err;
      const delay = RETRY_DELAYS_MS[i];
      const meta  = err?.response?.data?.error;
      console.warn(
        `[retry] ${context}: error transitorio de Meta (status=${err?.response?.status ?? '?'} code=${meta?.code ?? '?'}) — intento ${i + 2}/${attempts} en ${delay / 1000}s`,
      );
      await sleep(delay);
    }
  }
}

// Devuelve el wamid (id del mensaje en WhatsApp) para poder matchear luego los
// webhooks de status (ticks) y reacciones. null si no vino en la respuesta.
export async function sendWhatsAppText(to: string, text: string, tenantId?: string, numberId?: string | null): Promise<string | null> {
  const { token, phoneId } = await resolveCreds(tenantId, numberId);
  const headers     = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' };

  console.log(`[sendWhatsAppText] → ${to}: "${text.slice(0, 60)}"`);

  try {
    const res = await withTransientRetry(`sendWhatsAppText → ${to}`, () =>
      axios.post(
        `${BASE_URL}/${phoneId}/messages`,
        { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } },
        { headers },
      ),
    );
    const wamid = res.data?.messages?.[0]?.id ?? null;
    console.log(`[sendWhatsAppText] ✓ Enviado a ${to} wamid=${wamid}`);
    return wamid;
  } catch (err: any) {
    logApiError('sendWhatsAppText', err);
    throw err;
  }
}

export async function sendWhatsAppImage(to: string, imageUrl: string, caption: string, tenantId?: string, numberId?: string | null) {
  const { token, phoneId } = await resolveCreds(tenantId, numberId);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' };

  try {
    await withTransientRetry(`sendWhatsAppImage → ${to}`, () =>
      axios.post(
        `${BASE_URL}/${phoneId}/messages`,
        { messaging_product: 'whatsapp', to, type: 'image', image: { link: imageUrl, caption } },
        { headers },
      ),
    );
  } catch (err: any) {
    logApiError('sendWhatsAppImage', err);
    throw err;
  }
}

export async function sendWhatsAppTemplate(
  to: string,
  templateName: string,
  languageCode: string,
  variables: string[],
  phoneNumberId?: string,
  tenantId?: string,
  numberId?: string | null,
  buttons?: string[],
): Promise<string | null> {
  const creds   = await resolveCreds(tenantId, numberId);
  const token   = creds.token;
  // Un phoneNumberId explícito (ej. plantilla con número dedicado) tiene prioridad
  // sobre el del tenant/env.
  const phoneId = phoneNumberId ?? creds.phoneId;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' };

  const body: any = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: { name: templateName, language: { code: languageCode } },
  };

  const components: any[] = [];

  if (variables.length > 0) {
    components.push({
      type: 'body',
      parameters: variables.map((text) => ({ type: 'text', text })),
    });
  }

  // Botones de respuesta rápida: un componente por botón. El texto no se envía
  // (Meta usa el de la plantilla aprobada); solo importa la cantidad/índice, que
  // debe coincidir con los botones de la plantilla aprobada en Meta.
  if (buttons && buttons.length > 0) {
    buttons.forEach((_text, index) => {
      components.push({
        type: 'button',
        sub_type: 'quick_reply',
        index,
        parameters: [{ type: 'payload', payload: `btn_${index}` }],
      });
    });
  }

  if (components.length > 0) body.template.components = components;

  try {
    // Devolvemos el wamid (como sendWhatsAppText) para poder trackear ticks y
    // respuestas de botón de las campañas. null si no vino en la respuesta.
    const res = await withTransientRetry(`sendWhatsAppTemplate → ${to}`, () =>
      axios.post(`${BASE_URL}/${phoneId}/messages`, body, { headers }),
    );
    return res.data?.messages?.[0]?.id ?? null;
  } catch (err: any) {
    logApiError('sendWhatsAppTemplate', err);
    throw err;
  }
}

// Reacción a un mensaje del cliente (WhatsApp Reactions API).
// emoji = '' quita la reacción. messageId = wamid del mensaje a reaccionar.
export async function sendWhatsAppReaction(to: string, messageId: string, emoji: string, tenantId?: string, numberId?: string | null) {
  const { token, phoneId } = await resolveCreds(tenantId, numberId);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' };

  try {
    await withTransientRetry(`sendWhatsAppReaction → ${to}`, () =>
      axios.post(
        `${BASE_URL}/${phoneId}/messages`,
        { messaging_product: 'whatsapp', to, type: 'reaction', reaction: { message_id: messageId, emoji } },
        { headers },
      ),
    );
  } catch (err: any) {
    logApiError('sendWhatsAppReaction', err);
    throw err;
  }
}

export async function sendWhatsAppAudio(to: string, audioUrl: string, tenantId?: string, numberId?: string | null) {
  const { token, phoneId } = await resolveCreds(tenantId, numberId);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' };

  const payload = { messaging_product: 'whatsapp', to, type: 'audio', audio: { link: audioUrl } };

  try {
    await withTransientRetry(`sendWhatsAppAudio → ${to}`, () =>
      axios.post(`${BASE_URL}/${phoneId}/messages`, payload, { headers }),
    );
  } catch (err: any) {
    console.error(`[sendWhatsAppAudio] ✗ status=${err?.response?.status} body=${JSON.stringify(err?.response?.data ?? err?.message)}`);
    logApiError('sendWhatsAppAudio', err);
    throw err;
  }
}

// Crea (registra) una plantilla de mensaje en Meta. Queda en revisión hasta que
// Meta la aprueba. El `example` se genera con un valor de muestra por cada
// placeholder {{n}} del cuerpo (requerido por Meta para plantillas con variables).
export async function createMessageTemplate(def: {
  name: string;
  language: string;
  category: string;
  bodyText: string;
  buttons?: string[];
}, creds?: { token?: string; wabaId?: string }): Promise<any> {
  // Creds por tenant (envío desde el panel) o globales de env (fallback).
  const token   = creds?.token  ?? getToken();
  const wabaId  = creds?.wabaId ?? getBusinessAccountId();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' };

  // Cantidad de placeholders distintos {{n}} en el cuerpo.
  const placeholders = new Set((def.bodyText.match(/\{\{(\d+)\}\}/g) ?? []));
  const sample = ['Juan', 'valor2', 'valor3', 'valor4'].slice(0, placeholders.size);

  const components: any[] = [
    {
      type: 'BODY',
      text: def.bodyText,
      ...(placeholders.size > 0 ? { example: { body_text: [sample] } } : {}),
    },
  ];

  // Botones de respuesta rápida (Meta: hasta 3 QUICK_REPLY por plantilla).
  if (def.buttons && def.buttons.length > 0) {
    components.push({
      type: 'BUTTONS',
      buttons: def.buttons.slice(0, 3).map((text) => ({ type: 'QUICK_REPLY', text })),
    });
  }

  const body: any = {
    name:     def.name,
    language: def.language,
    category: def.category,
    components,
  };

  try {
    const res = await axios.post(`${BASE_URL}/${wabaId}/message_templates`, body, { headers });
    console.log(`[createMessageTemplate] ✓ "${def.name}" enviada a revisión:`, JSON.stringify(res.data));
    return res.data;
  } catch (err: any) {
    logApiError('createMessageTemplate', err);
    throw err;
  }
}

// El media de un mensaje entrante solo se puede leer con el token del número
// que lo recibió — por eso acepta tenantId/numberId como los senders.
export async function fetchWhatsAppMediaUrl(mediaId: string, tenantId?: string, numberId?: string | null): Promise<string> {
  const { token } = await resolveCreds(tenantId, numberId);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' };

  console.log(`[fetchWhatsAppMediaUrl] mediaId=${mediaId}`);

  try {
    const res = await axios.get(`${BASE_URL}/${mediaId}`, {
      headers,
      params: { fields: 'url' },
    });
    const url = res.data?.url as string;
    console.log(`[fetchWhatsAppMediaUrl] URL: ${url?.slice(0, 80)}`);
    return url;
  } catch (err: any) {
    logApiError('fetchWhatsAppMediaUrl', err);
    throw err;
  }
}
