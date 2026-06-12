import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { getSessionAgent } from '@/lib/current-agent';
import { sendWhatsAppText, sendWhatsAppTemplate } from '@/lib/meta/client';

async function resolveContacts(filter: string, tenantId: string) {
  const base = supabaseAdmin
    .from('contacts').select('id, phone, name, whatsapp_number_id').eq('tenant_id', tenantId).neq('blocked', true)
    .order('created_at', { ascending: true });

  if (filter.startsWith('phone:')) {
    const phone = filter.slice('phone:'.length).trim();
    const { data } = await base.eq('phone', phone);
    return data ?? [];
  }

  if (filter === 'inactivo_30d' || filter === 'inactivo_45d') {
    const days   = filter === 'inactivo_30d' ? 30 : 45;
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

  let contacts = await resolveContacts(campaign.target_filter ?? 'todos', session.tenant_id);
  if (campaign.send_limit) contacts = contacts.slice(0, Number(campaign.send_limit));
  const isTemplate = campaign.type === 'template_meta';
  const vars: string[] = Array.isArray(campaign.template_variables) ? campaign.template_variables : [];

  let sent = 0;

  for (const contact of contacts) {
    try {
      const resolvedVars = vars.map((v: string) =>
        v.trim().toLowerCase() === '{{nombre}}' ? (contact.name ?? contact.phone) : v
      );

      // Cada contacto recibe por SU número (el último por el que habló);
      // sin número asignado, resolveCreds cae al default del tenant.
      if (isTemplate) {
        await sendWhatsAppTemplate(
          contact.phone,
          campaign.template_name,
          campaign.template_language ?? 'es',
          resolvedVars,
          undefined,
          session.tenant_id,
          contact.whatsapp_number_id,
        );
      } else {
        await sendWhatsAppText(contact.phone, campaign.message, session.tenant_id, contact.whatsapp_number_id);
      }

      const msgContent = isTemplate
        ? `[Template: ${campaign.template_name}]${resolvedVars.length ? ` (${resolvedVars.join(', ')})` : ''}`
        : campaign.message;

      await supabaseAdmin.from('messages').insert({
        contact_id: contact.id,
        role:       'human',
        content:    msgContent,
        tenant_id:  session.tenant_id,
      });
      sent++;
    } catch {
      console.error(`[campaign send] Falló envío a ${contact.phone}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  await supabaseAdmin
    .from('campaigns')
    .update({ status: 'completada', sent_count: sent })
    .eq('id', campaignId).eq('tenant_id', session.tenant_id);

  return NextResponse.json({ ok: true, sent, total: contacts.length });
}
