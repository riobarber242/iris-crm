import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { requireAgentOrAdmin } from '@/lib/current-agent';
import { resolveCreds, createMessageTemplate } from '@/lib/meta/client';

// Resuelve el WABA del tenant con la misma prioridad que el resto del proyecto:
// número default activo → columna legacy del tenant → env global.
async function resolveWaba(tenantId: string): Promise<string | null> {
  const { data: num } = await supabaseAdmin
    .from('whatsapp_numbers').select('waba_id')
    .eq('tenant_id', tenantId).eq('is_default', true).eq('active', true).maybeSingle();
  if (num?.waba_id) return num.waba_id;

  const { data: t } = await supabaseAdmin
    .from('tenants').select('whatsapp_waba_id').eq('id', tenantId).maybeSingle();
  if (t?.whatsapp_waba_id) return t.whatsapp_waba_id;

  return process.env.WHATSAPP_BUSINESS_ACCOUNT_ID ?? process.env.WHATSAPP_WABA_ID ?? null;
}

// POST /api/whatsapp-templates/submit-to-meta  { templateId }
// Registra una plantilla guardada en Iris en Meta (queda pendiente de aprobación).
export async function POST(request: Request) {
  const session = await requireAgentOrAdmin();
  if (!session) return new NextResponse('Requiere rol admin o agent', { status: 403 });

  const body = await request.json().catch(() => null);
  const templateId = body?.templateId as string | undefined;
  if (!templateId) return NextResponse.json({ error: 'Falta templateId' }, { status: 400 });

  const { data: tpl } = await supabaseAdmin
    .from('whatsapp_templates')
    .select('id, name, language, body, buttons')
    .eq('id', templateId).eq('tenant_id', session.tenant_id).maybeSingle();
  if (!tpl) return NextResponse.json({ error: 'Plantilla no encontrada' }, { status: 404 });

  const { token } = await resolveCreds(session.tenant_id);
  const wabaId = await resolveWaba(session.tenant_id);
  if (!wabaId) return NextResponse.json({ error: 'No hay WABA configurado para este tenant.' }, { status: 400 });

  try {
    const res = await createMessageTemplate(
      {
        name:     tpl.name,
        language: tpl.language || 'es',
        category: 'MARKETING',
        bodyText: tpl.body,
        buttons:  Array.isArray(tpl.buttons) ? tpl.buttons : [],
      },
      { token, wabaId },
    );
    return NextResponse.json({ ok: true, meta_id: res?.id ?? null, status: res?.status ?? 'PENDING' });
  } catch (err: any) {
    const metaErr = err?.response?.data?.error;
    return NextResponse.json(
      { error: metaErr?.error_user_msg || metaErr?.message || err?.message || 'Meta rechazó la plantilla' },
      { status: 400 },
    );
  }
}
