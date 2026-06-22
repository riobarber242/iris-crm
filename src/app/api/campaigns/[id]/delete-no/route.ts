import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { getSessionAgent } from '@/lib/current-agent';

// POST /api/campaigns/[id]/delete-no
// Borra los contactos que respondieron "No" (el 2º botón, payload btn_1) a esta
// campaña. Acción destructiva: el front pide confirmación antes de llamar.
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });

  const { id: campaignId } = await params;

  // La campaña debe pertenecer al tenant del usuario.
  const { data: campaign } = await supabaseAdmin
    .from('campaigns').select('id').eq('id', campaignId).eq('tenant_id', session.tenant_id).maybeSingle();
  if (!campaign) return new NextResponse('Campaña no encontrada', { status: 404 });

  // Contactos que tocaron el botón 2 ("No" = payload btn_1) en esta campaña.
  const { data: rows, error } = await supabaseAdmin
    .from('campaign_message_status')
    .select('contact_id')
    .eq('campaign_id', campaignId)
    .eq('btn_payload', 'btn_1');
  if (error) return new NextResponse(error.message, { status: 500 });

  const contactIds = Array.from(
    new Set((rows ?? []).map((r: any) => r.contact_id).filter(Boolean)),
  ) as string[];
  if (contactIds.length === 0) return NextResponse.json({ ok: true, deleted: 0 });

  // Borrado acotado al tenant (doble filtro), por las dudas.
  const { error: delErr } = await supabaseAdmin
    .from('contacts').delete().eq('tenant_id', session.tenant_id).in('id', contactIds);
  if (delErr) return new NextResponse(delErr.message, { status: 500 });

  return NextResponse.json({ ok: true, deleted: contactIds.length });
}
