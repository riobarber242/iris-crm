import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { sendWhatsAppText } from '@/lib/meta/client';

// POST /api/campaigns/send { campaignId }
// Sends the campaign message to all matching contacts and marks it as "completada".
// Contacts are filtered by target_filter: 'todos' | 'cliente_activo' | 'inactivo' | 'nuevo'
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const campaignId = body?.campaignId as string | undefined;

  if (!campaignId) {
    return new NextResponse('Falta campaignId', { status: 400 });
  }

  // Fetch campaign
  const { data: campaign, error: cErr } = await supabaseAdmin
    .from('campaigns')
    .select('*')
    .eq('id', campaignId)
    .single();

  if (cErr || !campaign) {
    return new NextResponse('Campaña no encontrada', { status: 404 });
  }

  if (campaign.status === 'completada') {
    return new NextResponse('La campaña ya fue enviada', { status: 409 });
  }

  // Mark as "enviando"
  await supabaseAdmin
    .from('campaigns')
    .update({ status: 'enviando' })
    .eq('id', campaignId);

  // Build contact query based on target_filter
  let contactQuery = supabaseAdmin
    .from('contacts')
    .select('id, phone')
    .neq('blocked', true);

  const filter = campaign.target_filter as string | null;
  if (filter && filter !== 'todos') {
    contactQuery = contactQuery.eq('status', filter);
  }

  const { data: contacts, error: contactErr } = await contactQuery;

  if (contactErr) {
    await supabaseAdmin.from('campaigns').update({ status: 'borrador' }).eq('id', campaignId);
    return new NextResponse(contactErr.message, { status: 500 });
  }

  const targets = contacts ?? [];
  let sent = 0;

  for (const contact of targets) {
    try {
      await sendWhatsAppText(contact.phone, campaign.message);
      // Save outbound message to conversation history
      await supabaseAdmin.from('messages').insert({
        contact_id: contact.id,
        role:       'human',
        content:    campaign.message,
      });
      sent++;
    } catch {
      // Log failure but continue with remaining contacts
      console.error(`[campaign send] Falló envío a ${contact.phone}`);
    }
    // Small delay to avoid hitting WhatsApp rate limits
    await new Promise((r) => setTimeout(r, 100));
  }

  // Mark as completed with sent count
  await supabaseAdmin
    .from('campaigns')
    .update({ status: 'completada', sent_count: sent })
    .eq('id', campaignId);

  return NextResponse.json({ ok: true, sent, total: targets.length });
}
