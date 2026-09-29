import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { getSessionAgent } from '@/lib/current-agent';
import { inCleanupGroup, loadCampaignResults } from '@/lib/campaigns/results';

// GET /api/campaigns/[id]/results
// Contactos de la campaña por grupo (clicks por botón y fallidos con su motivo),
// con la marca de actividad posterior y de "no molestar". Alimenta el panel que se
// abre al tocar un chip de la tarjeta. Lectura: cualquier rol del tenant.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });

  const { id } = await params;
  const { data: campaign } = await supabaseAdmin
    .from('campaigns').select('id, template_name, template_language')
    .eq('id', id).eq('tenant_id', session.tenant_id).maybeSingle();
  if (!campaign) return new NextResponse('Campaña no encontrada', { status: 404 });

  const res = await loadCampaignResults(session.tenant_id, campaign);
  if ('error' in res) return NextResponse.json({ error: res.error }, { status: 500 });

  return NextResponse.json({
    ...res,
    // Candidatos por grupo de limpieza (ya sin los activos ni los borrados). La
    // acción recalcula con la misma función y exige que coincida.
    cleanup: {
      negativo: res.rows.filter((r) => inCleanupGroup(r, 'negativo', res.buttons)).length,
      invalido: res.rows.filter((r) => inCleanupGroup(r, 'invalido', res.buttons)).length,
    },
    canDelete: session.role === 'admin' || session.role === 'agent',
  }, { headers: { 'Cache-Control': 'no-store' } });
}
