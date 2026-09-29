import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { getSessionAgent } from '@/lib/current-agent';
import { ACTIVITY, logActivity } from '@/lib/activity-log';
import { addOptOuts, isMissingTable, phoneKey } from '@/lib/campaigns/optouts';

// "No molestar" manual desde la ficha del contacto. Cualquier rol del tenant (la
// marca es reversible). La clave es el TELÉFONO del contacto (ver lib/campaigns/
// optouts.ts): marcar/desmarcar acá afecta a cualquier contacto con ese número.
//
// GET    ?contactId=… → { optedOut, reason, created_at, created_by_name }
// POST   { contactId } → marca (motivo 'manual')
// DELETE { contactId } → quita la marca, sea cual sea su motivo

async function contactPhone(tenantId: string, contactId: unknown): Promise<string | null> {
  if (typeof contactId !== 'string' || !contactId) return null;
  const { data } = await supabaseAdmin
    .from('contacts').select('phone').eq('id', contactId).eq('tenant_id', tenantId).maybeSingle();
  const key = phoneKey(data?.phone);
  return key.length >= 6 ? key : null;
}

export async function GET(request: Request) {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });

  const phone = await contactPhone(session.tenant_id, new URL(request.url).searchParams.get('contactId'));
  if (!phone) return NextResponse.json({ error: 'Contacto no encontrado' }, { status: 404 });

  const { data, error } = await supabaseAdmin
    .from('contact_optouts').select('reason, created_at, created_by_name, source_campaign_id')
    .eq('tenant_id', session.tenant_id).eq('phone', phone).maybeSingle();
  if (error && !isMissingTable(error)) return NextResponse.json({ error: error.message }, { status: 500 });

  // Nombre de la campaña de origen, para el banner de la ficha ("Dijo que no en X").
  let campaign_name: string | null = null;
  if (data?.source_campaign_id) {
    const { data: camp } = await supabaseAdmin
      .from('campaigns').select('name')
      .eq('id', data.source_campaign_id).eq('tenant_id', session.tenant_id).maybeSingle();
    campaign_name = camp?.name ?? null;
  }

  return NextResponse.json(
    data
      ? { optedOut: true, reason: data.reason, created_at: data.created_at, created_by_name: data.created_by_name, campaign_name }
      : { optedOut: false },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

export async function POST(request: Request) {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });

  const body = await request.json().catch(() => null);
  const phone = await contactPhone(session.tenant_id, body?.contactId);
  if (!phone) return NextResponse.json({ error: 'Contacto no encontrado' }, { status: 404 });

  const { error } = await addOptOuts(session.tenant_id, [{ phone }], {
    reason: 'manual', actorId: session.sub ?? null, actorName: session.name ?? null,
  });
  if (error) return NextResponse.json({ error }, { status: 500 });

  await logActivity({
    session, action: ACTIVITY.CONTACT_OPTOUT, objectType: 'contact', objectId: body.contactId,
    details: { reason: 'manual' },
  });
  return NextResponse.json({ ok: true, optedOut: true });
}

export async function DELETE(request: Request) {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });

  const body = await request.json().catch(() => null);
  const phone = await contactPhone(session.tenant_id, body?.contactId);
  if (!phone) return NextResponse.json({ error: 'Contacto no encontrado' }, { status: 404 });

  const { error } = await supabaseAdmin
    .from('contact_optouts').delete().eq('tenant_id', session.tenant_id).eq('phone', phone);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await logActivity({
    session, action: ACTIVITY.CONTACT_OPTOUT_REMOVED, objectType: 'contact', objectId: body.contactId,
  });
  return NextResponse.json({ ok: true, optedOut: false });
}
