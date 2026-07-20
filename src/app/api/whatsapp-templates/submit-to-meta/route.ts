import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { requireAgentOrAdmin } from '@/lib/current-agent';
import { resolveCreds, createMessageTemplate } from '@/lib/meta/client';
import { resolveWaba, listTenantWabas } from '@/lib/waba';

// POST /api/whatsapp-templates/submit-to-meta  { templateId }
// Registra una plantilla guardada en Iris en Meta (queda pendiente de aprobación).
export async function POST(request: Request) {
  const session = await requireAgentOrAdmin();
  if (!session) return new NextResponse('Requiere rol admin o agent', { status: 403 });

  const body = await request.json().catch(() => null);
  const templateId = body?.templateId as string | undefined;
  if (!templateId) return NextResponse.json({ error: 'Falta templateId' }, { status: 400 });

  // Categoría con la que se registra en Meta. La elige el agente (MARKETING /
  // UTILITY / AUTHENTICATION); default MARKETING. Meta valida que el contenido
  // coincida con la categoría y rechaza si no.
  const category = body?.category || 'MARKETING';

  const { data: tpl } = await supabaseAdmin
    .from('whatsapp_templates')
    .select('id, name, language, body, buttons, waba_id')
    .eq('id', templateId).eq('tenant_id', session.tenant_id).maybeSingle();
  if (!tpl) return NextResponse.json({ error: 'Plantilla no encontrada' }, { status: 404 });

  const tenantId = session.tenant_id;

  // La plantilla se registra en SU WABA (la que tiene guardada), no en la del
  // número default: si no, una plantilla de la línea B terminaría aprobada en la
  // WABA A y Meta la rechazaría al enviarla (132001). Fallback a la WABA
  // principal solo para las legacy que todavía no tienen waba_id.
  const wabas  = await listTenantWabas(tenantId);
  const wabaId = tpl.waba_id ?? (await resolveWaba(tenantId));
  if (!wabaId) return NextResponse.json({ error: 'No hay WABA configurado para este tenant.' }, { status: 400 });

  // Token de la línea que pertenece a esa WABA (el token del default no sirve para
  // registrar en una WABA ajena). Si no la encontramos, caemos al default de antes.
  const owner = wabas.find((w) => w.wabaId === wabaId);
  const creds = owner ? { token: owner.token } : await resolveCreds(tenantId);

  try {
    const res = await createMessageTemplate(
      {
        name:     tpl.name,
        language: tpl.language || 'es',
        category,
        bodyText: tpl.body,
        buttons:  Array.isArray(tpl.buttons) ? tpl.buttons : [],
      },
      { token: creds.token, wabaId },
    );

    // Persistimos lo que devolvió Meta: la WABA donde quedó registrada (así una
    // plantilla legacy sin waba_id queda atada desde ya), el id y el estado
    // inicial. El punto de la UI arranca en naranja y pasa a verde al aprobarse
    // (lo detecta la sincronización).
    const status = String(res?.status ?? 'PENDING').toUpperCase();
    const { error: upErr } = await supabaseAdmin
      .from('whatsapp_templates')
      .update({
        waba_id:          wabaId,
        meta_template_id: res?.id ? String(res.id) : null,
        approval_status:  status,
        status_synced_at: new Date().toISOString(),
      })
      .eq('id', tpl.id).eq('tenant_id', tenantId);
    if (upErr) console.warn('[submit-to-meta] No se pudo guardar el estado de la plantilla:', upErr.message);

    return NextResponse.json({ ok: true, meta_id: res?.id ?? null, status });
  } catch (err: any) {
    const metaErr = err?.response?.data?.error;
    return NextResponse.json(
      { error: metaErr?.error_user_msg || metaErr?.message || err?.message || 'Meta rechazó la plantilla' },
      { status: 400 },
    );
  }
}
