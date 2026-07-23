import axios from 'axios';
import { verifyMetaSignature } from './verify';
import { sendWhatsAppText, resolveCreds, withTransientRetry } from './client';
import { readWaSecret, WaSecretUnreadableError } from './wa-secrets';
import { getOfflineMsg } from '../bot-config';
import { supabaseAdmin } from '../db';
import { irisSystemPrompt } from '../system-prompt';
import { inferProvinciaFromPhone } from '../phone-province';
import { decideBotResponse, BOT_FLOW_STATES } from './bot-decision';
import { notifyContactAgents } from '../push';
import { generateBotResponse } from '../groq';
import { insertMessage } from '../messages';
import { after } from 'next/server';
import { makeThumb, thumbPathFor } from '../thumb-generate';

// Tenant principal (fallback cuando no se puede resolver por whatsapp_phone_id).
const PRINCIPAL_TENANT_ID = '00000000-0000-0000-0000-000000000001';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Resuelve tenant + número a partir del phone_number_id que llega en el webhook.
//  1. whatsapp_numbers (multi-número por tenant).
//  2. Compat: tenants.whatsapp_phone_id (números aún no migrados a la tabla).
//  3. Sin match (o error) → Principal, sin número (numberId null = el envío
//     cae al default del tenant / env globales vía resolveCreds).
async function resolveTenantAndNumber(
  phoneNumberId: string | undefined,
): Promise<{ tenantId: string; numberId: string | null }> {
  if (!phoneNumberId) return { tenantId: PRINCIPAL_TENANT_ID, numberId: null };
  try {
    const { data: num } = await supabaseAdmin
      .from('whatsapp_numbers').select('id, tenant_id')
      .eq('phone_number_id', phoneNumberId).maybeSingle();
    if (num) return { tenantId: num.tenant_id, numberId: num.id };

    const { data } = await supabaseAdmin
      .from('tenants').select('id').eq('whatsapp_phone_id', phoneNumberId).maybeSingle();
    return { tenantId: data?.id ?? PRINCIPAL_TENANT_ID, numberId: null };
  } catch (err) {
    console.warn('[webhook] resolveTenantAndNumber falló, uso Principal:', err);
    return { tenantId: PRINCIPAL_TENANT_ID, numberId: null };
  }
}

// phone_number_id del payload (ya parseado), para resolver el app secret ANTES de
// validar la firma. Un webhook = una app de Meta, así que el primero alcanza.
function extractPhoneNumberId(payload: any): string | undefined {
  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const id = change?.value?.metadata?.phone_number_id;
      if (id) return id;
    }
  }
  return undefined;
}

// App secret con el que validar la firma del webhook:
//   1. whatsapp_numbers.app_secret del número (app propia del cliente, ej. Derki).
//   2. Fallback: META_APP_SECRET / WHATSAPP_APP_SECRET global (Casino 17Star).
// Solo elige QUÉ secret probar; la autenticidad la garantiza el HMAC posterior.
async function resolveAppSecret(phoneNumberId: string | undefined): Promise<string | undefined> {
  const globalSecret = process.env.META_APP_SECRET ?? process.env.WHATSAPP_APP_SECRET;
  if (!phoneNumberId) return globalSecret;
  try {
    const { data } = await supabaseAdmin
      .from('whatsapp_numbers').select('id, app_secret_enc')
      .eq('phone_number_id', phoneNumberId).maybeSingle();
    // null = la línea no tiene secret propio → global (legítimo, ej. 17Star).
    const perNumber = (readWaSecret(data?.app_secret_enc, 'app_secret', data?.id) ?? '').trim();
    return perNumber || globalSecret;
  } catch (err) {
    // FAIL-CLOSED (PR5): la línea TIENE su propio app_secret y no lo pudimos
    // descifrar. Validar con el global rechazaría igual (firmas distintas), pero
    // con un motivo engañoso: devolvemos undefined para que el log diga
    // "sin app secret" y quede claro que es un problema de credenciales, no una
    // firma inválida de Meta.
    if (err instanceof WaSecretUnreadableError) {
      console.error(`[webhook] ${err.message} — se rechaza el webhook (fail-closed)`);
      return undefined;
    }
    console.warn('[webhook] resolveAppSecret falló, uso secret global:', err);
    return globalSecret;
  }
}

// Resuelve el system prompt para Groq con esta prioridad:
//   1. system_prompt del operador asignado al contacto (si no está vacío)
//   2. system_prompt del tenant guardado en settings
//   3. irisSystemPrompt hardcodeado
// `assignedAgentId` es contacts.assigned_agent_id del contacto activo.
async function getSystemPrompt(assignedAgentId: string | null | undefined, tenantId: string): Promise<string> {
  // 1. Prompt por operador (agente asignado).
  if (assignedAgentId) {
    try {
      const { data: agent } = await supabaseAdmin
        .from('agents').select('system_prompt').eq('id', assignedAgentId).maybeSingle();
      const perAgent = (agent?.system_prompt ?? '').trim();
      if (perAgent) return perAgent;
    } catch {
      // si falla, caemos al prompt global / default
    }
  }

  // 2. Prompt del tenant (settings) → 3. default hardcodeado.
  try {
    const { data } = await supabaseAdmin
      .from('settings').select('value').eq('key', 'system_prompt').eq('tenant_id', tenantId).limit(1).maybeSingle();
    return data?.value ?? irisSystemPrompt;
  } catch {
    return irisSystemPrompt;
  }
}

// Híbrido acotado: cuando el usuario contesta algo fuera de guion en un estado del
// onboarding, intenta una respuesta natural con Groq usando el prompt del operador
// asignado, reencauzando hacia el objetivo del estado. Si Groq no está configurado
// o falla, devuelve null y el caller usa el mensaje hardcodeado de siempre.
async function aiSteerReply(
  stateGoal: string,
  userText: string,
  assignedAgentId: string | null,
  tenantId: string,
): Promise<string | null> {
  if (!process.env.GROQ_API_KEY) return null;        // sin Groq → guion hardcodeado
  if (!userText.trim()) return null;
  try {
    const base = await getSystemPrompt(assignedAgentId, tenantId);
    const systemPrompt =
      `${base}\n\nContexto: estás en el onboarding por WhatsApp y el usuario respondió ` +
      `algo fuera de lo esperado. Objetivo actual: ${stateGoal}. Respondé en UNA sola frase ` +
      `breve (máx 25 palabras), amable, en español argentino con voseo, y reencauzá la charla ` +
      `hacia ese objetivo. No inventes datos ni precios.`;
    const reply = (await generateBotResponse(systemPrompt, userText))?.trim();
    return reply || null;
  } catch (err) {
    console.warn('[bot] aiSteerReply falló, uso guion:', err);
    return null;
  }
}

const COMPROBANTES_BUCKET = 'comprobantes';
const BOT_ENABLED_KEY     = 'bot_enabled';

// Mensajes del bot.
const WELCOME_MSG     = '¡Hola! Soy Iris, asistente virtual 🤖 Para orientarte mejor necesito hacerte un par de preguntas. ¿Es tu primera vez con nosotros o ya tenés cuenta?';
const HANDOFF_MSG     = '¡Listo! Un operador humano te va a atender en breve 👋';
const OUT_OF_HOURS_MSG = 'Hola! En este momento no hay operadores disponibles. Te respondemos en cuanto volvamos 🙏';
// El mensaje de offline es configurable por tenant (settings key 'offline_msg',
// editable vía Iris AI / Configuración) con DEFAULT_OFFLINE_MSG como fallback.
// Se usa tanto para el aviso a contactos conocidos como para el cierre de
// onboarding cuando el modo offline está activo (mismo texto en ambos casos).

// El cliente avisa que YA es usuario/cliente → handoff directo al operador, sin
// onboardearlo. Se evalúa como primer mensaje y en varios estados del flujo.
const ALREADY_CLIENT_RE = /ya teng|ya ten[eé]s|tengo (una )?cuenta|tengo usuario|tengo (una )?ficha|ya soy|soy cliente|ya jug|ya jugu[eé]|tengo (un )?user/;

// ─── Image: full 4-step flow ──────────────────────────────────────────────────
// Step 1: GET graph.facebook.com/v21.0/{mediaId}?fields=url  → temporary download URL
// Step 2: GET that download URL with Bearer token             → image buffer
// Step 3: Upload buffer to Supabase Storage (service role)   → stored file
// Step 4: Construct permanent public URL manually             → saved to DB

export async function saveComprobanteImage(mediaId: string, contactId: string, waToken: string | null): Promise<string | null> {
  const supaUrl  = process.env.NEXT_PUBLIC_SUPABASE_URL;

  if (!waToken) {
    console.error('[saveComprobanteImage] Sin access token de WhatsApp para descargar el media');
    return null;
  }
  if (!supaUrl) {
    console.error('[saveComprobanteImage] NEXT_PUBLIC_SUPABASE_URL no configurado');
    return null;
  }

  // ── Step 1: resolve download URL from Graph API ──────────────────────────
  let downloadUrl: string;
  try {
    const metaRes = await withTransientRetry(`saveComprobanteImage Step1 ${mediaId}`, () =>
      axios.get(`https://graph.facebook.com/v21.0/${mediaId}`, {
        headers: { Authorization: `Bearer ${waToken}` },
        params:  { fields: 'url' },
        timeout: 15000,
      }),
    );
    downloadUrl = metaRes.data?.url as string;
    if (!downloadUrl) throw new Error('Graph API no devolvió url en la respuesta');
    console.log(`[saveComprobanteImage] Step1 ✓ downloadUrl: ${downloadUrl.slice(0, 80)}`);
  } catch (err: any) {
    const detail = err?.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error(`[saveComprobanteImage] Step1 ✗ Error Graph API: ${detail}`);
    return null;
  }

  // ── Step 2: download image buffer with Bearer token ──────────────────────
  let buffer: Buffer;
  let contentType: string;
  try {
    const imgRes = await withTransientRetry(`saveComprobanteImage Step2 ${mediaId}`, () =>
      axios.get<ArrayBuffer>(downloadUrl, {
        responseType: 'arraybuffer',
        headers:      { Authorization: `Bearer ${waToken}` },
        timeout:      30000,
      }),
    );
    buffer      = Buffer.from(imgRes.data);
    contentType = (imgRes.headers['content-type'] as string) || 'image/jpeg';
    console.log(`[saveComprobanteImage] Step2 ✓ ${buffer.length} bytes, contentType=${contentType}`);
  } catch (err: any) {
    const detail = err?.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error(`[saveComprobanteImage] Step2 ✗ Error descargando imagen: ${detail}`);
    return null;
  }

  // ── Step 3: upload to Supabase Storage ───────────────────────────────────
  const ext      = contentType.includes('png')  ? 'png'
                 : contentType.includes('webp') ? 'webp'
                 : contentType.includes('gif')  ? 'gif'
                 // Video entrante: ANTES que la rama de audio mp4/m4a, porque el mime
                 // de video es 'video/mp4' y si no caería mal en 'm4a' (audio).
                 : contentType.startsWith('video/') ? (contentType.includes('3gp') ? '3gp' : 'mp4')
                 // Audio entrante (notas de voz / audios): mapear los mime de Meta
                 // a una extensión real para que el <audio> del chat lo reproduzca.
                 : contentType.includes('ogg')  ? 'ogg'
                 : contentType.includes('mpeg') ? 'mp3'
                 : (contentType.includes('mp4') || contentType.includes('m4a')) ? 'm4a'
                 : contentType.includes('amr')  ? 'amr'
                 : contentType.startsWith('audio/') ? 'ogg'
                 // Documentos: PDF con su extensión real para que se sirva y
                 // se previsualice correctamente (antes caía al fallback jpg).
                 : contentType.includes('pdf')  ? 'pdf'
                 : 'jpg';
  const filePath = `${contactId}/${Date.now()}.${ext}`;

  console.log(`[saveComprobanteImage] Step3 uploading → comprobantes/${filePath}`);

  // Reintento del upload: Storage puede tener blips transitorios. Step1/2 ya
  // reintentan (withTransientRetry); este era el único paso sin retry.
  let uploadError: { message: string } | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { error } = await supabaseAdmin.storage
      .from(COMPROBANTES_BUCKET)
      .upload(filePath, buffer, { contentType, upsert: true });
    uploadError = error;
    if (!error) break;
    console.warn(`[saveComprobanteImage] Step3 intento ${attempt}/3 falló: ${error.message}`);
    if (attempt < 3) await sleep(1000 * attempt);
  }

  if (uploadError) {
    console.error(`[saveComprobanteImage] Step3 ✗ Supabase Storage error: ${uploadError.message}`);
    return null;
  }

  console.log(`[saveComprobanteImage] Step3 ✓ archivo guardado en Storage`);

  // Thumb pre-generado (best-effort, FUERA del camino de respuesta): solo para
  // imágenes raster (fotos y stickers → image/*). PDF/audio/video quedan sin thumb
  // (no se listan como miniatura). Corre en after() para NO sumar latencia al
  // webhook —que es el path más sensible—; la descarga+subida del original ya fue
  // bloqueante porque el mensaje la necesita. Si falla, el front cae al original.
  if (contentType.startsWith('image/')) {
    after(async () => {
      try {
        const thumb = await makeThumb(buffer);
        if (thumb) {
          await supabaseAdmin.storage
            .from(COMPROBANTES_BUCKET)
            .upload(thumbPathFor(filePath), thumb, { contentType: 'image/webp', upsert: true });
        }
      } catch (err) {
        console.warn('[saveComprobanteImage] No se pudo generar/subir el thumb:', err);
      }
    });
  }

  // ── Step 4: build permanent public URL ───────────────────────────────────
  // Format: {SUPABASE_URL}/storage/v1/object/public/comprobantes/{filePath}
  const publicUrl = `${supaUrl}/storage/v1/object/public/${COMPROBANTES_BUCKET}/${filePath}`;
  console.log(`[saveComprobanteImage] Step4 ✓ publicUrl: ${publicUrl}`);
  return publicUrl;
}

// Sube la imagen/documento entrante a Storage y devuelve su URL pública (o null
// si no se pudo). Se llama SIEMPRE que entra una imagen/documento, para que el
// mensaje se renderice como media en el chat del CRM.
//
// Etapa 4a: este paso YA NO crea un comprobante automáticamente. A partir de
// ahora nada entra solo a la bandeja de Cargas: el operador decide qué imágenes
// mandar a verificar con el botón "Enviar a verificar" desde la conversación
// (ver POST /api/comprobantes). Acá solo persistimos la imagen.
async function saveInboundImage(message: any, contactId: string, tenantId: string, numberId: string | null): Promise<{ url: string | null; mediaId: string | null }> {
  const mediaId = message.image?.id ?? message.document?.id ?? message.sticker?.id
                ?? message.audio?.id ?? message.voice?.id ?? message.video?.id ?? null;
  // El media solo puede descargarse con el token del número que lo recibió.
  let waToken: string | null = null;
  if (mediaId) {
    try {
      waToken = (await resolveCreds(tenantId, numberId)).token;
    } catch (err) {
      console.error('[saveInboundImage] No se pudo resolver token de WhatsApp:', err);
    }
  }
  const url = mediaId ? await saveComprobanteImage(mediaId, contactId, waToken) : null;

  if (!mediaId)        console.warn('[image] Sin mediaId en el payload');
  // Descarga fallida (p.ej. Meta caído): NO perdemos la referencia. Devolvemos el
  // media_id para guardarlo como pending y que el cron de reintento lo recupere.
  if (mediaId && !url) console.warn(`[image] Descarga/subida falló (media_id=${mediaId}) — se guarda pending para reintento`);

  return { url, mediaId };
}

// _type usado en el JSON del chat según el tipo de media entrante (null = no es media).
function mediaJsonType(type: string): 'image' | 'sticker' | 'audio' | 'video' | 'document' | null {
  if (type === 'image')    return 'image';
  if (type === 'sticker')  return 'sticker';
  if (type === 'audio' || type === 'voice') return 'audio';
  if (type === 'video')    return 'video';
  if (type === 'document') return 'document';
  return null;
}

// JSON del mensaje de media DESCARGADA OK (misma forma de siempre, por tipo).
function successMediaJson(mType: string, url: string, message: any): any {
  switch (mType) {
    case 'image':    return { _type: 'image', url, caption: (message.image?.caption ?? '').trim() };
    case 'sticker':  return { _type: 'sticker', url };
    case 'audio':    return { _type: 'audio', url };
    case 'video':    return { _type: 'video', url, caption: (message.video?.caption ?? '').trim() };
    case 'document': return { _type: 'document', url, filename: (message.document?.filename ?? '').trim() || null, mime: message.document?.mime_type ?? null, caption: (message.document?.caption ?? '').trim() };
    default:         return { _type: mType, url };
  }
}

// JSON del mensaje de media que NO se pudo descargar. Guarda el media_id (para que
// el cron de reintento la recupere) en vez de perder la referencia guardando el
// literal "image". pending:true → el chat lo muestra como "procesando…".
function pendingMediaJson(mType: string, mediaId: string, message: any): any {
  const base: any = { _type: mType, pending: true, media_id: mediaId };
  if (mType === 'image') base.caption = (message.image?.caption ?? '').trim();
  if (mType === 'video') base.caption = (message.video?.caption ?? '').trim();
  if (mType === 'document') {
    base.filename = (message.document?.filename ?? '').trim() || null;
    base.mime     = message.document?.mime_type ?? null;
    base.caption  = (message.document?.caption ?? '').trim();
  }
  return base;
}

// Vista previa corta de un mensaje citado (reply-to), para mostrar arriba de la
// burbuja "↩ Respondiendo a: …". Media → etiqueta con emoji; texto → recorte.
function previewOf(content: string | null | undefined): string {
  const c = (content ?? '').trim();
  if (!c) return 'Mensaje';
  try {
    const p = JSON.parse(c);
    if (p?._type === 'image')    return '📷 Imagen';
    if (p?._type === 'sticker')  return '🌟 Sticker';
    if (p?._type === 'audio')    return '🎤 Audio';
    if (p?._type === 'video')    return '🎬 Video';
    if (p?._type === 'document') return `📄 ${p.filename || 'Documento'}`;
    if (p?._type === 'location') return '📍 Ubicación';
    if (p?._type === 'contacts') return '👤 Contacto';
  } catch { /* no es JSON: es texto plano o un placeholder viejo */ }
  if (c === 'image')                 return '📷 Imagen';
  if (c === 'document')              return '📄 Documento';
  if (c === 'audio' || c === 'voice') return '🎤 Audio';
  if (c === 'sticker')               return '🌟 Sticker';
  if (c === 'video')                 return '🎬 Video';
  return c.length > 80 ? `${c.slice(0, 80)}…` : c;
}

// ─── Webhook entry ────────────────────────────────────────────────────────────

export async function handleWhatsappWebhook(
  rawBody: string,
  signature: string | undefined,
  payload: any,
) {
  const phoneNumberId = extractPhoneNumberId(payload);
  const appSecret = await resolveAppSecret(phoneNumberId);

  if (!verifyMetaSignature(signature, rawBody, appSecret)) {
    console.error(`[webhook] Firma inválida — rechazando (phone_number_id=${phoneNumberId ?? 'null'})`);
    return { status: 401, body: 'Firma no valida' };
  }

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const message of change.value?.messages ?? []) {
        try {
          await processMessage(change.value?.metadata?.phone_number_id, message, change.value?.contacts?.[0]);
        } catch (err) {
          console.error('[webhook] Error no manejado en processMessage:', err);
        }
      }
      // Webhooks de status (ticks): sent / delivered / read / failed.
      for (const status of change.value?.statuses ?? []) {
        try {
          await processStatus(status);
        } catch (err) {
          console.error('[webhook] Error no manejado en processStatus:', err);
        }
      }
    }
  }

  return { status: 200, body: 'EVENT_RECEIVED' };
}

// Actualiza el status de un mensaje saliente según el webhook de WhatsApp,
// matcheando por wamid (whatsapp_message_id). Para los ticks del CRM.
async function processStatus(status: any) {
  const wamid   = status?.id as string | undefined;
  const newStat = status?.status as string | undefined; // sent | delivered | read | failed
  if (!wamid || !newStat) return;
  if (!['sent', 'delivered', 'read', 'failed'].includes(newStat)) return;

  // Detalle del error de Meta (solo en 'failed'). Meta manda errors:[{code,title,
  // message,error_data:{details}}]. Lo capturamos para explicar POR QUÉ falló un envío
  // (número no está en WhatsApp, plantilla pausada, etc.). Antes se descartaba y el
  // fallo quedaba sin razón en ningún lado.
  const metaErr = Array.isArray(status?.errors) && status.errors.length > 0 ? status.errors[0] : null;
  const errCode  = metaErr?.code != null ? Number(metaErr.code) : null;
  const errTitle = (metaErr?.title ?? null) as string | null;
  const errMsg   = (metaErr?.error_data?.details ?? metaErr?.message ?? null) as string | null;
  if (newStat === 'failed') {
    console.warn(`[status] wamid=${wamid} FAILED code=${errCode ?? '?'} title="${errTitle ?? ''}" details="${errMsg ?? ''}"`);
  }

  const { error } = await supabaseAdmin
    .from('messages')
    .update({ status: newStat })
    .eq('whatsapp_message_id', wamid);
  if (error) console.warn(`[status] No se pudo actualizar status=${newStat} wamid=${wamid}:`, error.message);
  else       console.log(`[status] wamid=${wamid} → ${newStat}`);

  // Motivo del fallo en la fila del mensaje (columnas nuevas: ver
  // supabase-message-error.sql). Va en un update APARTE y best-effort, igual que
  // en campaign_message_status: si las columnas todavía no están migradas, falla
  // solo esto y el tick de arriba queda igual. Sin esto el operador ve "no
  // entregado" sin ninguna razón, y el motivo solo vivía en los logs de Vercel.
  if (newStat === 'failed' && metaErr) {
    const { error: errUpd } = await supabaseAdmin
      .from('messages')
      .update({ error_code: errCode, error_title: errTitle, error_message: errMsg })
      .eq('whatsapp_message_id', wamid);
    if (errUpd) console.warn('[status] No se guardó el detalle del error en messages (¿columnas error_* migradas?):', errUpd.message);
  }

  // ── Tracking de campañas ────────────────────────────────────────────────────
  // Si este wamid pertenece a un envío de campaña, refleja el tick en
  // campaign_message_status e incrementa el contador de la campaña UNA sola vez
  // por transición (delivered/read/failed), idempotente ante reenvíos de Meta.
  try {
    const { data: cms } = await supabaseAdmin
      .from('campaign_message_status')
      .select('id, campaign_id')
      .eq('wamid', wamid)
      .maybeSingle();
    if (cms?.campaign_id) {
      // Reclamo ATÓMICO de cada transición contable. Antes esto era un
      // read-modify-write con carrera: se leía el estado, se decidía el
      // incremento y recién después se escribía, así que dos reenvíos del mismo
      // status de Meta casi simultáneos leían ambos delivered_at=null y ambos
      // incrementaban (delivered_count inflado). Ahora el UPDATE condicional
      // (.is(col, null) / .neq('status','failed')) gatea el contador: sólo se
      // incrementa si la fila REALMENTE transicionó (afectó ≥1 fila). Postgres
      // serializa los UPDATE sobre la misma fila y reevalúa el WHERE contra la
      // versión ya commiteada, así que sólo el primero reclama; el reenvío
      // afecta 0 filas y no cuenta.
      let counterCol: string | null = null;
      if (newStat === 'delivered') {
        const { data: claimed } = await supabaseAdmin
          .from('campaign_message_status')
          .update({ status: 'delivered', delivered_at: new Date().toISOString() })
          .eq('id', cms.id).is('delivered_at', null).select('id');
        if (claimed && claimed.length > 0) counterCol = 'delivered_count';
      } else if (newStat === 'read') {
        const { data: claimed } = await supabaseAdmin
          .from('campaign_message_status')
          .update({ status: 'read', read_at: new Date().toISOString() })
          .eq('id', cms.id).is('read_at', null).select('id');
        if (claimed && claimed.length > 0) counterCol = 'read_count';
      } else if (newStat === 'failed') {
        const { data: claimed } = await supabaseAdmin
          .from('campaign_message_status')
          .update({ status: 'failed' })
          .eq('id', cms.id).neq('status', 'failed').select('id');
        if (claimed && claimed.length > 0) counterCol = 'failed_count';
      } else {
        // 'sent' u otros no contables: sólo reflejar el último status.
        await supabaseAdmin.from('campaign_message_status').update({ status: newStat }).eq('id', cms.id);
      }

      if (counterCol) {
        const { error: incErr } = await supabaseAdmin.rpc('increment_campaign_counter', { cid: cms.campaign_id, col: counterCol });
        if (incErr) console.warn(`[status] increment_campaign_counter ${counterCol} falló:`, incErr.message);
      }

      // Persistir el motivo del fallo (columnas nuevas: ver supabase-campaign-message-error.sql).
      // Update aparte y best-effort: si las columnas todavía no están migradas, solo falla
      // ESTO (queda en el log de arriba igual), no el tracking base ni el contador.
      if (newStat === 'failed' && metaErr) {
        const { error: errUpd } = await supabaseAdmin
          .from('campaign_message_status')
          .update({ error_code: errCode, error_title: errTitle, error_message: errMsg })
          .eq('id', cms.id);
        if (errUpd) console.warn('[status] No se guardó el detalle del error (¿columnas error_* migradas?):', errUpd.message);
      }
    }
  } catch (err) {
    console.warn('[status] Tracking de campaña falló (¿tabla campaign_message_status?):', err);
  }
}

// ─── Core message processor ───────────────────────────────────────────────────

async function processMessage(
  _phoneNumberId: string | undefined,
  message: any,
  contactMeta: any,
) {
  const messageId = message.id   as string | undefined;
  const from      = message.from as string | undefined;
  const type      = message.type as string;
  const text      = (message.text?.body ?? '').trim() as string;

  console.log(`[webhook] Entrante: from=${from} type=${type} text="${text.slice(0, 60)}"`);
  console.log(`[webhook] EnvCheck: TOKEN=${!!process.env.WHATSAPP_ACCESS_TOKEN} PHONE_ID=${!!process.env.WHATSAPP_PHONE_NUMBER_ID} SUPABASE=${!!process.env.SUPABASE_SERVICE_ROLE_KEY}`);

  if (!messageId || !from) {
    console.warn('[webhook] Mensaje sin id o from — ignorando');
    return;
  }

  // ── Multi-tenant: resolver tenant + número por el phone_number_id del webhook ─
  const { tenantId, numberId } = await resolveTenantAndNumber(_phoneNumberId);
  console.log(`[webhook] tenant=${tenantId} numero=${numberId ?? 'null'} (phone_number_id=${_phoneNumberId ?? 'null'})`);

  // ── Deduplication ──────────────────────────────────────────────────────────
  try {
    const { data: dup } = await supabaseAdmin
      .from('messages')
      .select('id')
      .eq('whatsapp_message_id', messageId)
      .maybeSingle();
    if (dup) {
      console.log(`[webhook] Duplicado detectado para messageId=${messageId} — ignorando`);
      return;
    }
  } catch {
    // If whatsapp_message_id column doesn't exist, skip dedup and continue
  }

  // ── Reacción entrante del cliente ───────────────────────────────────────────
  // Se aplica como badge sobre el mensaje original (matcheado por wamid). NO se
  // guarda como burbuja de texto ni dispara el bot. emoji vacío = quitó la reacción.
  if (type === 'reaction') {
    const targetWamid = message.reaction?.message_id as string | undefined;
    const emoji       = (message.reaction?.emoji ?? '') as string;
    console.log(`[webhook] Reacción entrante: target=${targetWamid} emoji="${emoji}"`);
    if (targetWamid) {
      try {
        const { error } = await supabaseAdmin
          .from('messages').update({ reaction: emoji || null }).eq('whatsapp_message_id', targetWamid);
        if (error) console.warn('[webhook] No se pudo guardar reacción entrante (¿falta columna?):', error.message);
      } catch (err) {
        console.error('[webhook] Excepción guardando reacción entrante:', err);
      }
    }
    return;
  }

  // ── Respuesta de botón (quick-reply de una plantilla de campaña) ────────────
  // El mensaje trae button.payload (btn_0/btn_1) y context.id = wamid del
  // template que enviamos. Lo matcheamos contra campaign_message_status para
  // registrar la respuesta y contar btn1/btn2. Solo cuenta el PRIMER click de
  // cada destinatario (idempotente ante reenvíos del webhook o re-clicks). No
  // dispara el bot.
  if (type === 'button') {
    const ctxWamid = message.context?.id as string | undefined;
    const payload  = (message.button?.payload ?? '') as string;
    const btnText  = (message.button?.text ?? '') as string;
    console.log(`[webhook] Botón entrante: payload="${payload}" text="${btnText}" context=${ctxWamid}`);
    if (ctxWamid) {
      try {
        const { data: cms } = await supabaseAdmin
          .from('campaign_message_status')
          .select('id, campaign_id, btn_payload, contact_id, tenant_id')
          .eq('wamid', ctxWamid)
          .maybeSingle();
        if (cms?.campaign_id) {
          const firstClick = !cms.btn_payload;
          await supabaseAdmin
            .from('campaign_message_status')
            .update({ btn_payload: payload, btn_text: btnText })
            .eq('id', cms.id);
          if (firstClick) {
            const col = payload === 'btn_0' ? 'btn1_count' : payload === 'btn_1' ? 'btn2_count' : null;
            if (col) {
              const { error: incErr } = await supabaseAdmin.rpc('increment_campaign_counter', { cid: cms.campaign_id, col });
              if (incErr) console.error(`[button] increment_campaign_counter ${col} FALLÓ campaign=${cms.campaign_id} contact=${cms.contact_id}:`, incErr.message);
            }
            // Además del contador agregado, registrar el click como evento visible
            // en la conversación del contacto: un chip centrado "✅ Apretó: …". Solo
            // en el PRIMER click (idempotente ante reenvíos del webhook / re-clicks).
            // insertMessage emite el Broadcast Fase 2 → aparece en vivo en el chat.
            if (cms.contact_id) {
              const { error: evErr } = await insertMessage({
                contact_id: cms.contact_id,
                role:       'system',
                content:    JSON.stringify({ _type: 'campaign_event', text: btnText || null, payload }),
                tenant_id:  cms.tenant_id,
              });
              if (evErr) console.error(
                `[button] CHIP NO INSERTADO campaign=${cms.campaign_id} contact=${cms.contact_id} payload=${payload}:`,
                evErr.message,
              );

              // Push del click: avisar aunque el operador no tenga la conversación
              // abierta, igual que una respuesta de texto libre (el chip solo se ve
              // si ya estás mirando el chat). Off del camino crítico con after();
              // trae el contacto para resolver el agente asignado y el nombre. Solo
              // en el PRIMER click (estamos dentro de firstClick → no repite).
              const cid = cms.contact_id, tid = cms.tenant_id, label = btnText;
              after((async () => {
                try {
                  const { data: c } = await supabaseAdmin
                    .from('contacts')
                    .select('id, name, phone, assigned_agent_id')
                    .eq('id', cid)
                    .maybeSingle();
                  if (!c) return;
                  await notifyContactAgents(c.assigned_agent_id ?? null, tid, {
                    title: 'IRIS',
                    body:  `${c.name || c.phone}: ✅ Apretó: ${label || 'el botón'}`,
                    url:   `/conversaciones/${c.id}`,
                    kind:  'conversation', // suena, como un mensaje entrante
                  });
                } catch (err) {
                  console.warn('[button] push del click falló (ignorado):', err);
                }
              })());
            }
          }
        }
      } catch (err) {
        console.error(`[button] Tracking de botón FALLÓ context=${ctxWamid}:`, err);
      }
    }
    return;
  }

  // ── Contact ────────────────────────────────────────────────────────────────
  const { contact, isNew } = await findOrCreateContact(from, contactMeta?.profile?.name ?? null, tenantId, numberId);
  if (!contact) {
    console.error('[webhook] No se pudo crear/obtener contacto para', from);
    return;
  }
  console.log(`[webhook] Contact: id=${contact.id} phone=${contact.phone} isNew=${isNew} status=${contact.status} conversation_state=${contact.conversation_state ?? 'null'}`);

  // ── Persistir por cuál número habla este contacto ───────────────────────────
  // Si escribió a OTRO número del tenant (o es un contacto previo a multi-número,
  // con null), las respuestas deben salir por el último número que usó.
  if (numberId && contact.whatsapp_number_id !== numberId) {
    const { error } = await supabaseAdmin
      .from('contacts').update({ whatsapp_number_id: numberId }).eq('id', contact.id);
    if (error) console.warn('[webhook] No se pudo actualizar whatsapp_number_id:', error.message);
    else {
      console.log(`[webhook] contact.whatsapp_number_id → ${numberId}`);
      contact.whatsapp_number_id = numberId;
    }
  }

  // ── Sincronizar identidad conocida (name ⇄ casino_username) ──────────────────
  // Si ya sabemos quién es (el contacto tiene name o casino_username con valor),
  // dejamos AMBOS campos seteados con el mismo valor. Prioridad: casino_username;
  // si no, name. Va ANTES de cualquier decisión de flujo (onboarding/known_client).
  // No corre para contactos nuevos (ambos null) ni si ya están sincronizados.
  {
    const known = (contact.casino_username ?? '').trim() || (contact.name ?? '').trim();
    if (known && (contact.casino_username !== known || contact.name !== known)) {
      const { error } = await supabaseAdmin
        .from('contacts')
        .update({ name: known, casino_username: known })
        .eq('id', contact.id);
      if (error) {
        console.warn('[webhook] Sync name/casino_username falló:', error.message);
      } else {
        contact.name           = known;
        contact.casino_username = known;
        console.log(`[webhook] Identidad sincronizada → name=casino_username="${known}"`);
      }
    }
  }

  // ── Push a los operadores: avisar que entró un mensaje de cliente ───────────
  // Fuera del camino crítico: se dispara ACÁ (antes de bajar la media y antes del
  // bot) y after() lo mantiene vivo tras responder el webhook. Antes esperaba, en
  // serie, (a) la descarga+subida del archivo de media —hasta 30 s— y (b) el envío
  // secuencial a cada dispositivo, retrasando el aviso Y la respuesta del bot. El
  // preview se arma con el `type` (NO usa la URL de la media), así que no depende de
  // la descarga. Best-effort: nunca rompe el flujo. Va después del dedup, así que un
  // reenvío del webhook no vuelve a notificar.
  {
    const pushPreview =
      type === 'text'                ? text
      : type === 'image'             ? '📷 Imagen'
      : type === 'document'          ? '📄 Documento'
      : ['audio', 'voice'].includes(type) ? '🎤 Audio'
      : type === 'video'             ? '🎬 Video'
      : type === 'sticker'           ? '🌟 Sticker'
      : type === 'location'          ? '📍 Ubicación'
      : type === 'contacts'          ? '👤 Contacto'
      : type;
    after(
      notifyContactAgents(contact.assigned_agent_id ?? null, tenantId, {
        title: 'IRIS',
        body: `${contact.name || contact.phone}: ${String(pushPreview).slice(0, 120)}`,
        url: `/conversaciones/${contact.id}`,
        kind: 'conversation', // suena, incluso en pantalla bloqueada
      }).catch((err) => console.warn('[webhook] notifyContactAgents falló (ignorado):', err)),
    );
  }

  // ── Imágenes/documentos: subir ANTES de guardar el mensaje, para que el
  //    mensaje entrante de tipo image se guarde como media (no como texto "image")
  //    y se renderice como imagen en el chat del CRM. Etapa 4a: NO se crea
  //    comprobante automático; el operador lo manda a verificar con el botón.
  let inboundMediaUrl: string | null = null;
  let inboundMediaId: string | null = null;
  if (['image', 'document', 'sticker', 'audio', 'voice', 'video'].includes(type)) {
    const r = await saveInboundImage(message, contact.id, tenantId, numberId);
    inboundMediaUrl = r.url;
    inboundMediaId  = r.mediaId;
  }

  // Ubicación y contactos compartidos no son "media" (no se descargan), pero los
  // guardamos como JSON estructurado para que el chat los renderice lindo (mapa /
  // ficha) en vez de mostrar el texto pelado "location"/"contacts".
  const locationJson = type === 'location' && message.location
    ? JSON.stringify({
        _type: 'location',
        lat: message.location.latitude, lng: message.location.longitude,
        name: (message.location.name ?? '').trim() || null,
        address: (message.location.address ?? '').trim() || null,
      })
    : null;
  const contactsJson = type === 'contacts' && Array.isArray(message.contacts)
    ? JSON.stringify({
        _type: 'contacts',
        contacts: message.contacts.map((c: any) => ({
          name: (c?.name?.formatted_name ?? '').trim() || null,
          phone: (c?.phones?.[0]?.phone ?? c?.phones?.[0]?.wa_id ?? '').trim() || null,
        })),
      })
    : null;

  // Contenido del mensaje del usuario. Media (imagen/sticker/audio/doc/video) se
  // guarda como JSON para que el chat del CRM lo renderice en vez de un placeholder.
  // Media descargada OK → JSON con la url. Media que falló la descarga (Meta caído,
  // etc.) → JSON pending con el media_id (recuperable por el cron), NO el literal
  // "image" (que se perdía sin referencia y rompía el chat).
  const mType = mediaJsonType(type);
  const userContent =
    type === 'text'              ? text
    : (mType && inboundMediaUrl) ? JSON.stringify(successMediaJson(mType, inboundMediaUrl, message))
    : (mType && inboundMediaId)  ? JSON.stringify(pendingMediaJson(mType, inboundMediaId, message))
    : locationJson ?? contactsJson ?? type;

  // ── Reply-to (respuesta citada) ─────────────────────────────────────────────
  // El mensaje trae context.id = wamid del mensaje citado. Guardamos ese wamid y un
  // preview corto (resuelto desde nuestra DB) para mostrar "↩ Respondiendo a: …".
  // Nota: context.forwarded existe para reenviados pero no lo tratamos acá.
  let replyToWamid: string | null = null;
  let replyToPreview: string | null = null;
  const quotedId = message.context?.id as string | undefined;
  if (quotedId) {
    replyToWamid = quotedId;
    try {
      const { data: quoted } = await supabaseAdmin
        .from('messages').select('content').eq('whatsapp_message_id', quotedId).maybeSingle();
      if (quoted) replyToPreview = previewOf(quoted.content);
    } catch { /* si falla la lookup, queda solo el wamid */ }
  }

  // ── Save user message ──────────────────────────────────────────────────────
  try {
    const { error } = await insertMessage({
      contact_id:          contact.id,
      role:                'user',
      content:             userContent,
      whatsapp_message_id: messageId,
      type,
      reply_to_wamid:      replyToWamid,
      reply_to_preview:    replyToPreview,
      tenant_id:           tenantId,
    });
    if (error) {
      console.warn('[webhook] Insert mensaje usuario falló:', error.message, '— reintentando sin campos opcionales');
      // Retry without fields that might not exist in the schema
      const { error: err2 } = await insertMessage({
        contact_id:          contact.id,
        role:                'user',
        content:             userContent,
        whatsapp_message_id: messageId,
        tenant_id:           tenantId,
      });
      if (err2) console.error('[webhook] Retry insert también falló:', err2.message);
    }
  } catch (err) {
    console.error('[webhook] Error inesperado guardando mensaje usuario:', err);
  }

  // ── Bot enabled check ──────────────────────────────────────────────────────
  const botEnabled = await getBotEnabled(tenantId);
  console.log(
    `[webhook] bot_enabled=${botEnabled} | contact.id=${contact.id}` +
    ` status=${contact.status} conversation_state=${contact.conversation_state ?? 'null'}`,
  );

  // ── Reply helper ───────────────────────────────────────────────────────────
  async function replyAndSave(
    textResp: string,
    opts: { newState?: string | null; markInProgress?: boolean } = {},
  ) {
    console.log(`[replyAndSave] → "${textResp.slice(0, 60)}" opts=${JSON.stringify(opts)}`);

    // 1. Save to DB
    let dbInsertOk = false;
    let insertedId: string | null = null;
    try {
      const { data: inserted, error } = await insertMessage({
        contact_id: contact.id, role: 'assistant', content: textResp, tenant_id: tenantId,
      });
      if (error) {
        console.error('[replyAndSave] DB insert error:', error.message);
      } else {
        dbInsertOk  = true;
        insertedId  = inserted?.id ?? null;
      }
    } catch (err) {
      console.error('[replyAndSave] DB insert excepción:', err);
    }

    // 2. Send via WhatsApp API — always attempt regardless of DB result.
    // Sale por el número que recibió el mensaje (numberId); si es null,
    // resolveCreds cae al default del tenant / env globales.
    try {
      const wamid = await sendWhatsAppText(from!, textResp, tenantId, numberId);
      if (dbInsertOk && insertedId) {
        const { error } = await supabaseAdmin.from('messages')
          .update({ status: 'sent', whatsapp_message_id: wamid })
          .eq('id', insertedId);
        if (error) console.error('[replyAndSave] No se pudo marcar sent:', error.message);
      }
    } catch (err) {
      console.error('[replyAndSave] WhatsApp send error — mensaje NO llegó al usuario');
      if (dbInsertOk && insertedId) {
        const { error } = await supabaseAdmin.from('messages')
          .update({ status: 'failed' })
          .eq('id', insertedId);
        if (error) console.error('[replyAndSave] No se pudo marcar failed:', error.message);
      }
    }

    // 3. Update contact state
    // Two-step: status first (column always exists), then conversation_state separately.
    // This ensures en_proceso is always set even if conversation_state column is missing.
    try {
      if (opts.markInProgress) {
        const { error: stErr } = await supabaseAdmin
          .from('contacts').update({ status: 'en_proceso' }).eq('id', contact.id);
        if (stErr) console.warn('[replyAndSave] status update error:', stErr.message);
        else       console.log('[replyAndSave] contact.status → en_proceso');
      }

      const stateUpdate: Record<string, any> = {};
      if ('newState' in opts)  stateUpdate.conversation_state = opts.newState ?? null;
      if (opts.markInProgress) stateUpdate.conversation_state = 'done';

      if (Object.keys(stateUpdate).length > 0) {
        const { error: csErr } = await supabaseAdmin
          .from('contacts').update(stateUpdate).eq('id', contact.id);
        if (csErr) console.warn('[replyAndSave] conversation_state update error (columna puede no existir):', csErr.message);
      }
    } catch (err) {
      console.error('[replyAndSave] Contact update excepción:', err);
    }
  }

  // (La imagen/comprobante ya se subió y guardó arriba, antes de guardar el mensaje.)

  // ── MODO OFFLINE ─────────────────────────────────────────────────────────
  // El onboarding SIEMPRE corre para contactos bot-owned (nuevos o ya en un
  // onboarding iniciado por el bot), aunque haya offline_mode: así un cliente
  // nuevo se onboardea igual y al terminar recibe el cierre con "esperá al
  // operador" (handoffMsg → getOfflineMsg/offline_msg en offline, ver más abajo).
  // Los contactos conocidos/preexistentes sí reciben el aviso de offline y corta.
  // OJO: tiene que ser `isNew || inBotFlow`, no solo `isNew`: isNew es true una
  // única vez (primer mensaje); los mensajes 2..N del onboarding traen isNew=false
  // pero un conversation_state bot-owned, y deben seguir el flujo igual.
  const offline = await getOfflineMode(tenantId);
  if (offline) {
    const inBotFlow = BOT_FLOW_STATES.has(contact.conversation_state ?? '');
    const botOwned  = isNew || inBotFlow;
    // Solo se onboardea en offline si el bot está prendido. Si el bot está
    // apagado (kill switch) o es un contacto conocido/preexistente, mandamos el
    // aviso de offline y cortamos (comportamiento previo, sin regresión).
    if (!botEnabled || !botOwned) {
      console.log('[bot] OFFLINE — bot apagado o contacto conocido → aviso directo, corta');
      if (!contact.blocked) await replyAndSave(await getOfflineMsg(tenantId));
      return;
    }
    console.log('[bot] OFFLINE — contacto nuevo/onboarding con bot prendido → sigue el flujo');
  }

  // ── Bot SOLO onboardea contactos SIN nombre (conversaciones nuevas) ─────────
  // Si el contacto ya tiene identidad asignada (name o casino_username — el sync
  // de arriba los deja iguales) y no está ya derivado, NO se onboardea: queda en
  // cola del operador EN SILENCIO, sin mandarle ningún mensaje al cliente. Cubre
  // el caso de un contacto que el operador nombró a mitad del flujo
  // (conversation_state en un estado de onboarding): aun así se corta el
  // onboarding, sin importar el state. Solo marcamos conversation_state en
  // 'known_client' para que classifyPending lo pinte ROJO 🔴 online; el humano lo
  // atiende vía los indicadores de color, no vía un saludo del bot.
  const known = (contact.casino_username ?? '').trim() || (contact.name ?? '').trim();
  const alreadyHandled = ['known_client', 'done'].includes(contact.conversation_state ?? '');
  if (known && botEnabled && !contact.blocked && !alreadyHandled) {
    console.log(`[bot] Contacto con nombre asignado ("${known}") → handoff a humano, SIN mensaje (solo estado)`);
    const { error: kcErr } = await supabaseAdmin
      .from('contacts')
      .update({ conversation_state: 'known_client' })
      .eq('id', contact.id);
    if (kcErr) console.warn('[bot] known_client state update error (columna puede no existir):', kcErr.message);
    return;
  }

  // Mensaje de cierre del onboarding (handoff): en offline usa el mismo mensaje
  // editable (offline_msg) que reciben los contactos conocidos; online, HANDOFF_MSG.
  const handoffMsg = offline ? await getOfflineMsg(tenantId) : HANDOFF_MSG;

  // ── Decisión del bot (regla principal + horario) ─────────────────────────
  // Lógica pura en bot-decision.ts (testeable). Resumen:
  //  · bot apagado / bloqueado            → silencio
  //  · contacto preexistente              → silencio (cola del operador)
  //  · número nuevo fuera de horario      → aviso "no hay operadores" (una vez)
  //  · onboarding en curso fuera de hora  → silencio (no se onboardea de noche)
  //  · resto (atiende el bot, en horario) → seguir el flujo
  // En OFFLINE el bot atiende igual el onboarding (no se aplica el corte por
  // horario), y el cierre usa handoffMsg.
  const operatorAvailable = offline ? true : await hasActiveOperator(tenantId);
  const decision = decideBotResponse({
    botEnabled,
    blocked: !!contact.blocked,
    isNew,
    conversationState: (contact.conversation_state as string | null) ?? null,
    operatorAvailable,
  });
  console.log(`[bot] decisión=${JSON.stringify(decision)} isNew=${isNew} state=${contact.conversation_state ?? 'null'} operador=${operatorAvailable}`);

  if (decision.action === 'silent') return;
  if (decision.action === 'out_of_hours') {
    await replyAndSave(OUT_OF_HOURS_MSG);
    return;
  }
  // decision.action === 'flow' → continúa con image-in-flow / audio / state machine

  // ─── A partir de acá: contacto nuevo o en onboarding iniciado por el bot ──

  // ─── IMAGE / DOCUMENT (en flujo) ──────────────────────────────────────────
  if (type === 'image' || type === 'document') {
    const imgState = (contact.conversation_state as string | null) ?? null;
    if (imgState === 'waiting_screenshot') {
      console.log('[image] Es captura del canal → continuando flujo de onboarding');
      await replyAndSave('Buenisimo! Sos de recargar seguido?', { newState: 'asked_if_loader' });
    } else {
      console.log(`[image] Comprobante en flujo (state="${imgState}") → acuse de recibo`);
      await replyAndSave('Comprobante recibido ✅ Un operador lo verifica enseguida.');
    }
    return;
  }

  // ─── AUDIO / VOICE / VIDEO / STICKER ─────────────────────────────────────
  if (['audio', 'voice', 'video', 'sticker'].includes(type)) {
    console.log(`[bot] Tipo no-texto: ${type} — respondiendo con mensaje de texto`);
    await replyAndSave('Soy Iris, asistente virtual 🤖 No puedo escuchar audios ni ver stickers, escribime por texto 😊');
    return;
  }

  // ─── STATE MACHINE ────────────────────────────────────────────────────────
  const state     = contact.conversation_state as string | null ?? null;
  const lowerText = text.toLowerCase();
  console.log(`[bot] state="${state}" text="${text.slice(0, 60)}"`);

  switch (state) {
    // ── Contacto nuevo: bienvenida + primera pregunta ─────────────────────────
    case null:
    case 'greeting': {
      // Si en el primer mensaje ya avisa que es cliente → directo al operador.
      if (ALREADY_CLIENT_RE.test(lowerText)) {
        await replyAndSave(handoffMsg, { markInProgress: true });
      } else {
        await replyAndSave(WELCOME_MSG, { newState: 'asked_intention' });
      }
      break;
    }

    // ── ¿Primera vez o ya tiene cuenta? ───────────────────────────────────────
    case 'asked_intention': {
      if (ALREADY_CLIENT_RE.test(lowerText)) {
        // Ya tiene cuenta → lo atiende un operador.
        await replyAndSave(handoffMsg, { markInProgress: true });
      } else if (/primera|primer|nuev[oa]|reci[eé]n|no teng|empez|arranco|soy nuevo/.test(lowerText)) {
        // Primera vez → onboarding.
        await replyAndSave(
          'Unite a mi canal de WhatsApp y mandame la captura. Ahí subo promos, horarios y novedades 👉 https://whatsapp.com/channel/0029VbCHhpyGOj9me9y9pF3F',
          { newState: 'waiting_screenshot' },
        );
      } else {
        const ai = await aiSteerReply(
          'que el usuario aclare si es su primera vez o si ya tiene cuenta',
          text, contact.assigned_agent_id ?? null, tenantId,
        );
        await replyAndSave(ai ?? '¿Es tu primera vez con nosotros o ya tenés cuenta?');
      }
      break;
    }

    // ── Waiting for channel screenshot (text message) ─────────────────────────
    case 'waiting_screenshot': {
      if (ALREADY_CLIENT_RE.test(lowerText) || /no puedo|no puedo mandar|no puedo enviar|no puedo subir/.test(lowerText)) {
        await replyAndSave(handoffMsg, { markInProgress: true });
      } else {
        const ai = await aiSteerReply(
          'que el usuario mande la captura del canal de WhatsApp para poder continuar',
          text, contact.assigned_agent_id ?? null, tenantId,
        );
        await replyAndSave(
          ai ?? 'Necesito que me mandes la captura del canal de WhatsApp para poder continuar. Si no podés, avisame.',
        );
      }
      break;
    }

    // ── After receiving image, asked if they load ─────────────────────────────
    case 'asked_if_loader': {
      if (/(^si$|^sí$|si!|sí!|obvio|claro|siempre|dale|ofc|por supuesto)/.test(lowerText)) {
        await replyAndSave(
          'Buenisimo! Estoy buscando clientes que recarguen conmigo 💪 El saldo de regalo es solo para probar la plataforma. Los premios se retiran cuando usás una recarga. Si estás de acuerdo, decime tu nombre y te creo la cuenta. Además te doy un 20% extra en tu primera recarga 🔥',
          { newState: 'asked_name' },
        );
      } else if (/(^no$|nono|no gracias|no quiero|paso)/.test(lowerText)) {
        await replyAndSave(handoffMsg, { markInProgress: true });
      } else {
        const ai = await aiSteerReply(
          'que el usuario responda si recarga seguido (sí o no)',
          text, contact.assigned_agent_id ?? null, tenantId,
        );
        await replyAndSave(ai ?? 'Sos de recargar seguido? Respondé si o no 😊');
      }
      break;
    }

    // ── Fin del onboarding → handoff al operador ──────────────────────────────
    case 'asked_name': {
      // El nombre lo asigna el operador desde el CRM; el bot no lo escribe.
      await replyAndSave(handoffMsg, { markInProgress: true });
      break;
    }

    // ── Estado no mapeado (no debería ocurrir en bot-owned) → handoff seguro ──
    case 'done':
    default: {
      console.warn(`[bot] Estado no mapeado: "${state}" — handoff al operador`);
      await replyAndSave(handoffMsg, { markInProgress: true });
      break;
    }
  }
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

const CONTACT_COLS =
  'id, phone, name, status, casino_username, conversation_state, last_read_at, blocked, assigned_agent_id, whatsapp_number_id';

// Extracts the national significant number (area code + subscriber) so numbers
// stored in different formats still match. WhatsApp sends AR mobiles as
// 549XXXXXXXXXX (no '+'), while contacts may be saved as 54XXXXXXXXXX (no 9),
// +549XXXXXXXXXX, or just the area+number. Stripping country code 54 and the
// mobile '9' yields a stable ~10-digit core we can suffix-match on.
function phoneCore(raw: string): string {
  let d = (raw ?? '').replace(/\D/g, '');
  if (d.startsWith('54')) d = d.slice(2);
  if (d.startsWith('9') && d.length > 10) d = d.slice(1);
  return d;
}

// Devuelve { contact, isNew }. isNew=true SOLO cuando el contacto fue creado
// en esta llamada (número completamente desconocido). Un match exacto o flexible
// → isNew=false (el número ya existía, en cualquier formato).
async function findOrCreateContact(
  phone: string,
  _whatsappName: string | null,
  tenantId: string,
  numberId: string | null,
): Promise<{ contact: any | null; isNew: boolean }> {
  // _whatsappName is intentionally ignored — bot never writes name to contacts.
  // Explicit column list avoids PostgREST schema-cache issues with recently added columns.
  try {
    // 1. Exact match (fast path).
    const { data: exact } = await supabaseAdmin
      .from('contacts')
      .select(CONTACT_COLS)
      .eq('tenant_id', tenantId)
      .eq('phone', phone)
      .limit(1)
      .maybeSingle();

    if (exact) {
      return { contact: exact, isNew: false };
    }

    // 2. Flexible match by normalized core — catches contacts saved in a
    //    different phone format (with '+', no country code, AR '9', etc.).
    //    Without this they'd be re-created as nameless "unknown" contacts.
    const core = phoneCore(phone);
    if (core.length >= 8) {
      const { data: fuzzy } = await supabaseAdmin
        .from('contacts')
        .select(CONTACT_COLS)
        .eq('tenant_id', tenantId)
        .ilike('phone', `%${core}`)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();

      if (fuzzy) {
        console.log(
          `[findOrCreateContact] Match flexible: from="${phone}" → contacto existente ` +
          `phone="${fuzzy.phone}" name=${JSON.stringify(fuzzy.name ?? null)}`,
        );
        return { contact: fuzzy, isNew: false };
      }
    }

    // 3. No match anywhere → create new contact.
    const provincia = inferProvinciaFromPhone(phone);
    const { data: inserted, error } = await supabaseAdmin
      .from('contacts')
      .insert({
        phone, name: null, status: 'nuevo', tenant_id: tenantId,
        whatsapp_number_id: numberId,
        ...(provincia ? { provincia } : {}),
      })
      .select('*')
      .single();

    if (error) {
      console.error('[findOrCreateContact] Insert error:', error.message);
      // Race condition: otro proceso lo creó en paralelo → existía, isNew=false.
      const { data: retry } = await supabaseAdmin
        .from('contacts').select('*').eq('tenant_id', tenantId).eq('phone', phone).limit(1).maybeSingle();
      return { contact: retry ?? null, isNew: false };
    }

    return { contact: inserted, isNew: true };
  } catch (err) {
    console.error('[findOrCreateContact] Excepción:', err);
    return { contact: null, isNew: false };
  }
}

// "HH:MM[:SS]" → minutos desde medianoche. null si no hay horario.
function timeToMinutes(t: string | null | undefined): number | null {
  if (!t) return null;
  const [h, m] = String(t).split(':');
  const hh = Number(h), mm = Number(m ?? 0);
  if (Number.isNaN(hh)) return null;
  return hh * 60 + mm;
}

// ¿Hay al menos un operador activo dentro de su horario AHORA (hora Argentina)?
// Un agente activo sin horario definido cuenta como disponible 24h.
// Fail-open: ante error o sin agentes, asume que hay operadores (no manda el
// aviso de fuera de horario por las dudas).
async function hasActiveOperator(tenantId: string): Promise<boolean> {
  try {
    const { data: agents, error } = await supabaseAdmin
      .from('agents')
      .select('active, schedule_start, schedule_end')
      .eq('tenant_id', tenantId);

    if (error) { console.warn('[hasActiveOperator] Error leyendo agents:', error.message); return true; }
    if (!agents || agents.length === 0) return true;

    // Argentina es UTC-3 fijo.
    const arg    = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const nowMin = arg.getUTCHours() * 60 + arg.getUTCMinutes();

    for (const a of agents) {
      if (!a.active) continue;
      const s = timeToMinutes(a.schedule_start);
      const e = timeToMinutes(a.schedule_end);
      if (s === null || e === null) return true; // activo sin horario → disponible 24h
      // Horario normal (s<=e) o que cruza medianoche (s>e).
      const within = s <= e ? (nowMin >= s && nowMin <= e) : (nowMin >= s || nowMin <= e);
      if (within) return true;
    }
    return false;
  } catch (err) {
    console.warn('[hasActiveOperator] Excepción:', err);
    return true; // fail open
  }
}

// Modo OFFLINE: si está activo, el bot solo manda el aviso de "no operamos".
// Default false (fail-closed: ante error NO se asume offline).
async function getOfflineMode(tenantId: string): Promise<boolean> {
  try {
    const { data, error } = await supabaseAdmin
      .from('settings').select('value').eq('key', 'offline_mode').eq('tenant_id', tenantId).limit(1).maybeSingle();
    if (error) { console.warn('[getOfflineMode] Error leyendo settings:', error.message); return false; }
    return data?.value === 'true';
  } catch (err) {
    console.warn('[getOfflineMode] Excepción:', err);
    return false;
  }
}

async function getBotEnabled(tenantId: string): Promise<boolean> {
  try {
    // Read ALL possible key formats for bot control (de este tenant)
    const { data: rows, error } = await supabaseAdmin
      .from('settings')
      .select('key, value')
      .in('key', [BOT_ENABLED_KEY, 'bot_mode'])
      .eq('tenant_id', tenantId)
      .limit(10);

    if (error) {
      console.error('[getBotEnabled] Error leyendo settings:', error.message);
      return true; // fail open
    }

    const map: Record<string, string> = {};
    for (const row of rows ?? []) map[row.key] = row.value;

    console.log('[getBotEnabled] settings encontrados:', JSON.stringify(map));

    // Priority 1: bot_enabled (our canonical key)
    if ('bot_enabled' in map) {
      const raw     = map.bot_enabled;
      const enabled = raw !== 'false' && raw !== false as any;
      console.log(`[getBotEnabled] via bot_enabled="${raw}" → enabled=${enabled}`);
      return enabled;
    }

    // Priority 2: bot_mode (alternative format, 'bot'=enabled, 'human'=disabled)
    if ('bot_mode' in map) {
      const raw     = map.bot_mode;
      const enabled = raw === 'bot' || raw === 'true';
      console.log(`[getBotEnabled] via bot_mode="${raw}" → enabled=${enabled}`);
      return enabled;
    }

    console.log('[getBotEnabled] Sin fila en settings → default enabled=true');
    return true;
  } catch (err) {
    console.error('[getBotEnabled] Excepción:', err);
    return true; // fail open
  }
}
