import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { getSessionAgent } from '@/lib/current-agent';
import { syncTemplateStatuses } from '@/lib/templates-sync';

// POST /api/whatsapp-templates/sync
// Baja de Meta el estado de aprobación de las plantillas del tenant (1 llamada a
// la Graph API por WABA) y devuelve la lista ya actualizada. Lo llaman la pantalla
// de Plantillas y el asistente de campañas al abrirse, más el botón "↻ Sincronizar".
//
// Cualquier sesión del tenant: es una lectura de estado, no modifica plantillas
// (solo su approval_status/waba_id, que son metadatos que vienen de Meta).
export async function POST() {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });

  // Best-effort: si Meta falla, igual devolvemos la lista local (con el estado
  // que hubiera). La pantalla nunca debe quedarse en blanco por esto.
  const result = await syncTemplateStatuses(session.tenant_id);

  const { data, error } = await supabaseAdmin
    .from('whatsapp_templates')
    .select('id, name, language, body, buttons, created_at, waba_id, approval_status, meta_template_id, status_synced_at')
    .eq('tenant_id', session.tenant_id)
    .order('created_at', { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    templates: data ?? [],
    updated: result.updated,
    wabas:   result.wabas,
    errors:  result.errors,
  });
}
