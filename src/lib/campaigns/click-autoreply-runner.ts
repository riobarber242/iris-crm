// Runner del auto-enganche al click de botón (lado servidor). Lo invoca el webhook
// (src/lib/meta/handler.ts) dentro de un after(), así que NO bloquea el 200 del
// webhook y todo su manejo de errores es interno (nunca tira).
//
// Flujo:
//   1. Resuelve el mensaje según la POSICIÓN del botón (ver click-autoreply.ts).
//   2. Manda el texto libre al instante del click (ventana lo más fresca posible).
//   3. Si el texto libre falla por ventana cerrada (131047) y hay plantilla de
//      fallback configurada para esa posición, dispara la plantilla en su lugar.

import { supabaseAdmin } from '../db';
import { insertMessage } from '../messages';
import { sendWhatsAppText, sendWhatsAppTemplate } from '../meta/client';
import {
  resolveAutoReply,
  parseButtonIndex,
  type AutoReplyConfig,
} from './click-autoreply';

type FireOpts = {
  tenantId: string;
  numberId: string | null; // línea por la que responder (la que recibió el click)
  contactId: string;
  campaignId: string;
  payload: string;         // 'btn_0' | 'btn_1' | …
};

// Dispara la plantilla de respaldo cuando el texto libre no entra por ventana
// cerrada. Best-effort: si tampoco entra, se loguea y listo.
async function sendFallbackTemplate(opts: FireOpts, phone: string, templateName: string): Promise<void> {
  try {
    // La plantilla de fallback se identifica solo por nombre (su idioma no se conoce
    // de antemano). Puede existir en varias cuentas (misma name, distinto waba_id):
    // tomamos la primera de forma determinística en vez de maybeSingle (que rompería).
    const { data: tplRows } = await supabaseAdmin
      .from('whatsapp_templates')
      .select('language, body, buttons')
      .eq('tenant_id', opts.tenantId)
      .eq('name', templateName)
      .order('created_at', { ascending: true })
      .limit(1);
    const tpl = tplRows?.[0];

    const language = (tpl?.language as string) || 'es';
    const buttons  = Array.isArray(tpl?.buttons) ? (tpl!.buttons as string[]) : [];

    const wamid = await sendWhatsAppTemplate(
      phone, templateName, language, [], undefined, opts.tenantId, opts.numberId, buttons,
    );

    await insertMessage({
      contact_id:          opts.contactId,
      role:                'assistant',
      content:             (tpl?.body as string) || `[Plantilla: ${templateName}]`,
      tenant_id:           opts.tenantId,
      status:              'sent',
      whatsapp_message_id: wamid,
    });
    console.log(`[click-autoreply] fallback plantilla "${templateName}" enviado contact=${opts.contactId}`);
  } catch (err: any) {
    console.error('[click-autoreply] fallback de plantilla falló:', err?.response?.data ?? err?.message);
  }
}

export async function fireClickAutoReply(opts: FireOpts): Promise<void> {
  try {
    const idx = parseButtonIndex(opts.payload);
    if (idx == null) return;

    // 1) Config del tenant. Sin fila / switch off → no hace nada.
    const { data: cfgRow } = await supabaseAdmin
      .from('campaign_click_autoreply')
      .select('enabled, messages')
      .eq('tenant_id', opts.tenantId)
      .maybeSingle();
    const config: AutoReplyConfig = {
      enabled:  !!cfgRow?.enabled,
      messages: Array.isArray(cfgRow?.messages) ? cfgRow!.messages : [],
    };
    if (!config.enabled) return;

    // 2) Teléfono del contacto + cantidad de botones de la plantilla (para saber
    //    cuál es el "último" = negativo).
    const [{ data: contact }, { data: campaign }] = await Promise.all([
      supabaseAdmin.from('contacts').select('phone').eq('id', opts.contactId).maybeSingle(),
      supabaseAdmin.from('campaigns').select('template_name, template_language').eq('id', opts.campaignId).maybeSingle(),
    ]);
    if (!contact?.phone) return;

    let buttonCount = 0;
    if (campaign?.template_name) {
      // Keyeamos por idioma + limit(1): el mismo nombre puede estar en varias cuentas.
      const { data: tplRows } = await supabaseAdmin
        .from('whatsapp_templates')
        .select('buttons')
        .eq('tenant_id', opts.tenantId)
        .eq('name', campaign.template_name)
        .eq('language', campaign.template_language ?? 'es')
        .limit(1);
      if (Array.isArray(tplRows?.[0]?.buttons)) buttonCount = tplRows[0].buttons.length;
    }

    // 3) ¿Qué mandamos? (respeta switch, defaults primero/último y posiciones
    //    intermedias sin texto.)
    const resolved = resolveAutoReply(config, idx, buttonCount);
    if (!resolved) return;

    // 4) Persistir + enviar el texto libre. insertMessage emite el Broadcast Fase 2
    //    → aparece en vivo en el chat, como una respuesta del asistente.
    const { data: inserted } = await insertMessage({
      contact_id: opts.contactId,
      role:       'assistant',
      content:    resolved.text,
      tenant_id:  opts.tenantId,
      status:     'sent',
    });

    try {
      const wamid = await sendWhatsAppText(contact.phone, resolved.text, opts.tenantId, opts.numberId);
      if (inserted?.id) {
        await supabaseAdmin.from('messages')
          .update({ status: 'sent', whatsapp_message_id: wamid })
          .eq('id', inserted.id);
      }
      console.log(`[click-autoreply] texto libre enviado btn=${idx} contact=${opts.contactId}`);
    } catch (err: any) {
      const code = err?.response?.data?.error?.code ?? null;
      if (inserted?.id) {
        await supabaseAdmin.from('messages')
          .update({
            status:        'failed',
            error_code:    code,
            error_message: err?.response?.data?.error?.message ?? null,
          })
          .eq('id', inserted.id);
      }
      // Ventana cerrada + plantilla de fallback configurada → disparar la plantilla.
      if (code === 131047 && resolved.fallbackTemplate) {
        console.log(`[click-autoreply] 131047 en texto libre; voy al fallback de plantilla contact=${opts.contactId}`);
        await sendFallbackTemplate(opts, contact.phone, resolved.fallbackTemplate);
      } else {
        console.error(`[click-autoreply] texto libre falló code=${code} contact=${opts.contactId}`);
      }
    }
  } catch (err) {
    console.error('[click-autoreply] runner falló (ignorado):', err);
  }
}
