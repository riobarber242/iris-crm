import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { getSessionAgent } from '@/lib/current-agent';
import { sendWhatsAppText, sendWhatsAppTemplate } from '@/lib/meta/client';
import { insertMessage } from '@/lib/messages';

// El envío hace sleeps entre mensajes (intervalo configurable + pausas). Subimos
// el límite de ejecución de la función para listas grandes. OJO: aun así el plan
// de Vercel impone un techo — para listas muy grandes conviene send_limit o
// trocear el envío.
export const maxDuration = 300;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function resolveContacts(filter: string, tenantId: string, targetNumberId: string | null) {
  let base = supabaseAdmin
    .from('contacts').select('id, phone, name, whatsapp_number_id').eq('tenant_id', tenantId).neq('blocked', true)
    .order('created_at', { ascending: true });

  // Campaña segmentada por línea: solo contactos asignados a ese número.
  if (targetNumberId) base = base.eq('whatsapp_number_id', targetNumberId);

  if (filter.startsWith('phone:')) {
    const phone = filter.slice('phone:'.length).trim();
    const { data } = await base.eq('phone', phone);
    return data ?? [];
  }

  // Inactivos sin recargar en los últimos X días (X dinámico: inactivo_Xd).
  const inactiveMatch = filter.match(/^inactivo_(\d+)d$/);
  if (inactiveMatch) {
    const days   = Math.min(365, Math.max(1, Number(inactiveMatch[1])));
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();

    const [{ data: inactivos }, { data: recentRecargas }] = await Promise.all([
      base.eq('status', 'inactivo'),
      supabaseAdmin
        .from('comprobantes')
        .select('contact_id')
        .eq('tenant_id', tenantId)
        .eq('estado', 'verificado')
        .gte('created_at', cutoff)
        .order('created_at', { ascending: true }),
    ]);

    const recentIds = new Set((recentRecargas ?? []).map((r: any) => r.contact_id));
    return (inactivos ?? []).filter((c: any) => !recentIds.has(c.id));
  }

  if (filter && filter !== 'todos') {
    const { data } = await base.eq('status', filter);
    return data ?? [];
  }

  const { data } = await base;
  return data ?? [];
}

export async function POST(request: Request) {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });

  const body = await request.json().catch(() => null);
  const campaignId = body?.campaignId as string | undefined;
  if (!campaignId) return new NextResponse('Falta campaignId', { status: 400 });

  const { data: campaign, error: cErr } = await supabaseAdmin
    .from('campaigns').select('*').eq('id', campaignId).eq('tenant_id', session.tenant_id).single();

  if (cErr || !campaign) return new NextResponse('Campaña no encontrada', { status: 404 });
  if (campaign.status === 'completada') return new NextResponse('La campaña ya fue enviada', { status: 409 });

  await supabaseAdmin.from('campaigns').update({ status: 'enviando' }).eq('id', campaignId).eq('tenant_id', session.tenant_id);

  // Selección individual (por id) tiene prioridad sobre el filtro por categoría.
  // Se re-valida contra el tenant y se respeta `blocked`.
  const explicitIds: string[] = Array.isArray(campaign.recipient_ids)
    ? campaign.recipient_ids.filter((x: unknown) => typeof x === 'string')
    : [];
  let contacts;
  if (explicitIds.length > 0) {
    const { data } = await supabaseAdmin
      .from('contacts')
      .select('id, phone, name, whatsapp_number_id')
      .eq('tenant_id', session.tenant_id)
      .in('id', explicitIds)
      .neq('blocked', true);
    contacts = data ?? [];
  } else {
    contacts = await resolveContacts(campaign.target_filter ?? 'todos', session.tenant_id, campaign.target_number_id ?? null);
  }

  // Exclusión inteligente: no reenviar a contactos ya contactados por las
  // campañas seleccionadas. Se re-validan los ids contra el tenant.
  const excludeIds: string[] = Array.isArray(campaign.exclude_campaign_ids) ? campaign.exclude_campaign_ids : [];
  if (excludeIds.length > 0) {
    try {
      const { data: ownCampaigns } = await supabaseAdmin
        .from('campaigns').select('id').eq('tenant_id', session.tenant_id).in('id', excludeIds);
      const validIds = (ownCampaigns ?? []).map((c: any) => c.id);
      if (validIds.length > 0) {
        const { data: prev } = await supabaseAdmin
          .from('campaign_recipients').select('contact_id').in('campaign_id', validIds);
        const alreadySent = new Set((prev ?? []).map((r: any) => r.contact_id));
        contacts = contacts.filter((c: any) => !alreadySent.has(c.id));
      }
    } catch (err) {
      console.warn('[campaign send] Exclusión falló (¿tabla campaign_recipients?), envío sin excluir:', err);
    }
  }

  if (campaign.send_limit) contacts = contacts.slice(0, Number(campaign.send_limit));
  const isTemplate = campaign.type === 'template_meta';
  const vars: string[] = Array.isArray(campaign.template_variables) ? campaign.template_variables : [];

  // Botones de respuesta rápida de la plantilla (viven en whatsapp_templates).
  let buttons: string[] = [];
  if (isTemplate && campaign.template_name) {
    const { data: tpl } = await supabaseAdmin
      .from('whatsapp_templates')
      .select('buttons')
      .eq('tenant_id', session.tenant_id)
      .eq('name', campaign.template_name)
      .maybeSingle();
    if (Array.isArray(tpl?.buttons)) buttons = tpl.buttons;
  }

  // ── Config de ritmo de envío (con defaults seguros si faltan columnas) ───────
  const intervalMin = Math.max(0, Number(campaign.interval_min_sec ?? 1) || 0);
  const intervalMax = Math.max(intervalMin, Number(campaign.interval_max_sec ?? 3) || 0);
  const pauseEvery  = Math.max(0, Number(campaign.pause_every ?? 0) || 0);
  const pauseSecs   = Math.max(0, Number(campaign.pause_seconds ?? 0) || 0);

  let sent = 0;
  const sentContactIds: string[] = [];

  for (const contact of contacts) {
    try {
      const resolvedVars = vars.map((v: string) =>
        v.trim().toLowerCase() === '{{nombre}}' ? (contact.name ?? contact.phone) : v
      );

      // Cada contacto recibe por SU número (el último por el que habló);
      // sin número asignado, resolveCreds cae al default del tenant.
      let wamid: string | null = null;
      if (isTemplate) {
        wamid = await sendWhatsAppTemplate(
          contact.phone,
          campaign.template_name,
          campaign.template_language ?? 'es',
          resolvedVars,
          undefined,
          session.tenant_id,
          contact.whatsapp_number_id,
          buttons,
        );
      } else {
        await sendWhatsAppText(contact.phone, campaign.message, session.tenant_id, contact.whatsapp_number_id);
      }

      const msgContent = isTemplate
        ? `[Template: ${campaign.template_name}]${resolvedVars.length ? ` (${resolvedVars.join(', ')})` : ''}`
        : campaign.message;

      await insertMessage({
        contact_id: contact.id,
        role:       'human',
        content:    msgContent,
        tenant_id:  session.tenant_id,
      });

      // Registrar el envío para trackear ticks y respuestas de botón por wamid.
      if (isTemplate && wamid) {
        const { error: cmsErr } = await supabaseAdmin.from('campaign_message_status').insert({
          campaign_id: campaignId,
          contact_id:  contact.id,
          tenant_id:   session.tenant_id,
          wamid,
          status:      'sent',
        });
        if (cmsErr) console.warn('[campaign send] No se registró campaign_message_status (¿tabla?):', cmsErr.message);
      }

      sent++;
      sentContactIds.push(contact.id);
    } catch {
      console.error(`[campaign send] Falló envío a ${contact.phone}`);
    }

    // Pausa automática cada N mensajes; si no, intervalo aleatorio entre min y max.
    if (pauseEvery > 0 && pauseSecs > 0 && sent > 0 && sent % pauseEvery === 0) {
      await sleep(pauseSecs * 1000);
    } else {
      const delayMs = (intervalMin + Math.random() * (intervalMax - intervalMin)) * 1000;
      await sleep(delayMs);
    }
  }

  // Registrar destinatarios para que futuras campañas puedan excluirlos. Si la
  // tabla campaign_recipients no existe todavía, no rompe el envío.
  if (sentContactIds.length > 0) {
    const { error: recErr } = await supabaseAdmin
      .from('campaign_recipients')
      .insert(sentContactIds.map((cid) => ({ campaign_id: campaignId, contact_id: cid })));
    if (recErr) console.warn('[campaign send] No se registraron destinatarios (¿tabla campaign_recipients?):', recErr.message);
  }

  await supabaseAdmin
    .from('campaigns')
    .update({ status: 'completada', sent_count: sent })
    .eq('id', campaignId).eq('tenant_id', session.tenant_id);

  return NextResponse.json({ ok: true, sent, total: contacts.length });
}
