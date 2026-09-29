import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { getSessionAgent } from '@/lib/current-agent';
import { ACTIVITY, logActivity } from '@/lib/activity-log';
import { addOptOuts } from '@/lib/campaigns/optouts';
import { inCleanupGroup, loadCampaignResults, type CleanupGroup } from '@/lib/campaigns/results';

// POST /api/campaigns/[id]/cleanup
// body: { group: 'negativo' | 'invalido', action: 'optout' | 'delete',
//         contactIds: string[], expectedCount: number }
//
// Limpieza post-campaña sobre los contactos que eligió el operador. Reemplaza a
// /delete-no (que borraba siempre btn_1 —el del medio en plantillas de 3 botones—,
// sin mirar el rol ni si el contacto había vuelto a estar activo).
//
// Garantías:
//  · El conjunto se RECALCULA acá con la misma función del listado. Solo se procesan
//    los ids pedidos que sigan siendo candidatos; si eso no da exactamente
//    expectedCount (alguien escribió o cargó mientras tanto, u otro operador ya
//    los limpió) → 409 y el panel vuelve a pedir confirmación con el número nuevo.
//  · 'optout' → cualquier rol (es reversible). 'delete' → solo admin y agente, mismo
//    criterio que el borrado masivo por categoría.
//  · 'delete' también marca "no molestar" ANTES de borrar: si el número se vuelve a
//    importar, no recibe campañas.
const GROUPS: CleanupGroup[] = ['negativo', 'invalido'];
const REASON = { negativo: 'boton_negativo', invalido: 'numero_invalido' } as const;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });

  const body = await request.json().catch(() => null);
  const group  = body?.group as CleanupGroup;
  const action = body?.action as 'optout' | 'delete';
  const expectedCount = Number(body?.expectedCount);
  const requested: string[] = Array.isArray(body?.contactIds)
    ? Array.from(new Set<string>(body.contactIds.filter((x: unknown): x is string => typeof x === 'string')))
    : [];

  if (!GROUPS.includes(group) || (action !== 'optout' && action !== 'delete')) {
    return NextResponse.json({ error: 'Grupo o acción inválidos' }, { status: 400 });
  }
  if (!Number.isInteger(expectedCount) || expectedCount <= 0 || requested.length !== expectedCount) {
    return NextResponse.json({ error: 'La cantidad confirmada no coincide con la selección' }, { status: 400 });
  }
  if (action === 'delete' && session.role !== 'admin' && session.role !== 'agent') {
    return NextResponse.json({ error: 'Eliminar contactos requiere rol admin o agente' }, { status: 403 });
  }

  const { id } = await params;
  const { data: campaign } = await supabaseAdmin
    .from('campaigns').select('id, name, template_name, template_language')
    .eq('id', id).eq('tenant_id', session.tenant_id).maybeSingle();
  if (!campaign) return NextResponse.json({ error: 'Campaña no encontrada' }, { status: 404 });

  const res = await loadCampaignResults(session.tenant_id, campaign);
  if ('error' in res) return NextResponse.json({ error: res.error }, { status: 500 });

  // Candidatos vigentes del grupo. Para 'optout' se descartan los ya marcados (no
  // hay nada que hacer con ellos y el panel no los deja seleccionar).
  const eligible = new Map<string, { phone: string | null }>();
  for (const r of res.rows) {
    if (!inCleanupGroup(r, group, res.buttons)) continue;
    if (action === 'optout' && r.opted_out) continue;
    eligible.set(r.contact_id!, { phone: r.phone });
  }
  const target = requested.filter((cid) => eligible.has(cid));
  if (target.length !== expectedCount) {
    return NextResponse.json({
      error: `La lista cambió: ${expectedCount - target.length} de los ${expectedCount} contactos ya no corresponden (volvieron a estar activos o ya se procesaron). Revisá la lista y confirmá de nuevo.`,
      eligibleCount: eligible.size,
    }, { status: 409 });
  }

  // 1) "No molestar" (en las dos acciones).
  const { error: optErr } = await addOptOuts(
    session.tenant_id,
    target.map((cid) => ({ phone: eligible.get(cid)!.phone })),
    { reason: REASON[group], campaignId: campaign.id, actorId: session.sub ?? null, actorName: session.name ?? null },
  );
  if (optErr) return NextResponse.json({ error: `No se pudo marcar "no molestar": ${optErr}` }, { status: 500 });

  // 2) Borrado (acotado al tenant). CASCADE → se van también sus mensajes y
  //    comprobantes. El tracking de campañas conserva el phone; su contact_id queda
  //    apuntando a un contacto que ya no existe (en la base viva no hay FK a contacts).
  let deleted = 0;
  if (action === 'delete') {
    for (let i = 0; i < target.length; i += 200) {
      const slice = target.slice(i, i + 200);
      const { error, count } = await supabaseAdmin
        .from('contacts').delete({ count: 'exact' })
        .eq('tenant_id', session.tenant_id).in('id', slice);
      if (error) {
        return NextResponse.json({ error: error.message, deleted }, { status: 500 });
      }
      deleted += count ?? 0;
    }
  }

  await logActivity({
    session,
    action:     action === 'delete' ? 'contact_deleted' : ACTIVITY.CONTACT_OPTOUT,
    objectType: 'campaign',
    objectId:   campaign.id,
    details:    { bulk: true, campaign_cleanup: true, group, count: target.length, campaign_name: campaign.name },
  });

  return NextResponse.json({ ok: true, action, group, count: target.length, deleted });
}
