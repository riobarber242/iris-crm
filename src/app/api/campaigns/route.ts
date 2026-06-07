import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { getSessionAgent } from '@/lib/current-agent';

export async function GET() {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });

  const { data, error } = await supabaseAdmin
    .from('campaigns')
    .select('*')
    .eq('tenant_id', session.tenant_id)
    .order('created_at', { ascending: false });

  if (error) return new NextResponse(error.message, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(request: Request) {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });

  const body = await request.json();
  const { name, message, target_filter, type, template_name, template_language, template_variables, send_limit } = body;

  if (!name) return new NextResponse('Falta nombre', { status: 400 });

  const campaignType = type === 'template_meta' ? 'template_meta' : 'texto_libre';

  if (campaignType === 'texto_libre' && !message?.trim()) {
    return new NextResponse('Falta mensaje', { status: 400 });
  }
  if (campaignType === 'template_meta' && !template_name?.trim()) {
    return new NextResponse('Falta nombre de template', { status: 400 });
  }

  const { data, error } = await supabaseAdmin.from('campaigns').insert({
    name,
    message:            campaignType === 'texto_libre' ? message : null,
    target_filter:      target_filter ?? 'todos',
    status:             'borrador',
    type:               campaignType,
    template_name:      campaignType === 'template_meta' ? template_name.trim() : null,
    template_language:  campaignType === 'template_meta' ? (template_language ?? 'es') : null,
    template_variables: campaignType === 'template_meta' ? (template_variables ?? []) : null,
    send_limit:         send_limit ? Number(send_limit) : null,
    tenant_id:          session.tenant_id,
  }).select('*').single();

  if (error) return new NextResponse(error.message, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(request: Request) {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });

  const { campaignId } = await request.json();
  if (!campaignId) return new NextResponse('Falta campaignId', { status: 400 });

  const { data: campaign } = await supabaseAdmin
    .from('campaigns').select('status').eq('id', campaignId).eq('tenant_id', session.tenant_id).single();
  if (!campaign) return new NextResponse('No encontrada', { status: 404 });
  if (campaign.status !== 'borrador') {
    return new NextResponse('Solo se pueden eliminar campañas en borrador', { status: 409 });
  }

  const { error } = await supabaseAdmin.from('campaigns').delete().eq('id', campaignId).eq('tenant_id', session.tenant_id);
  if (error) return new NextResponse(error.message, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function PATCH(request: Request) {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });

  const body = await request.json();
  const { campaignId, status } = body;

  if (!campaignId || !['borrador', 'enviando', 'completada'].includes(status)) {
    return new NextResponse('Falta campaignId o estado válido', { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from('campaigns').update({ status }).eq('id', campaignId).eq('tenant_id', session.tenant_id).select('*').single();

  if (error) return new NextResponse(error.message, { status: 500 });
  return NextResponse.json(data);
}
