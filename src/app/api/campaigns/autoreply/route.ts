import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { getSessionAgent, requireAgentOrAdmin } from '@/lib/current-agent';
import { normalizeMessages } from '@/lib/campaigns/click-autoreply';

// Config del auto-enganche al click de botón de campaña, por tenant.
//  - GET: switch + mensajes por posición (cualquier sesión del tenant).
//  - PUT: guardar (solo admin y agent; operator → 403).
// Scope SIEMPRE el tenant del usuario autenticado. service-role, como el resto.

export async function GET() {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });

  const { data } = await supabaseAdmin
    .from('campaign_click_autoreply')
    .select('enabled, messages')
    .eq('tenant_id', session.tenant_id)
    .maybeSingle();

  return NextResponse.json({
    enabled:  !!data?.enabled,
    messages: Array.isArray(data?.messages) ? data.messages : [],
  });
}

export async function PUT(request: Request) {
  const session = await requireAgentOrAdmin();
  if (!session) return new NextResponse('Requiere rol admin o agent', { status: 403 });

  const body     = await request.json().catch(() => null);
  const enabled  = !!body?.enabled;
  const messages = normalizeMessages(body?.messages);

  const { error } = await supabaseAdmin
    .from('campaign_click_autoreply')
    .upsert(
      { tenant_id: session.tenant_id, enabled, messages, updated_at: new Date().toISOString() },
      { onConflict: 'tenant_id' },
    );

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ enabled, messages });
}
