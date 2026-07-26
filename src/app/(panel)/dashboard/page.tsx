export const dynamic = 'force-dynamic';

import DashboardClient from '@/components/DashboardClient';
import CajaResumen from '@/components/CajaResumen';
import { getSessionAgent } from '@/lib/current-agent';
import { planForTenant } from '@/lib/plan-guard';
import { hasFeature } from '@/lib/plan';

export default async function DashboardPage() {
  // El plan se resuelve en el SERVIDOR y baja como prop: el primer render ya
  // sale con o sin engranaje de personalización, sin el parpadeo de esperar a
  // /api/auth/me y sin pedir el layout (que en esos planes devuelve 404).
  const session = await getSessionAgent();
  const plan    = session ? await planForTenant(session.tenant_id) : null;

  return (
    <div className="space-y-8">
      {/* La banda de caja del dashboard sale de comprobantes/fichas: fuera de
          los planes con Caja no tiene datos ni sección a la que linkear. */}
      {hasFeature(plan, 'caja') && <CajaResumen />}
      <DashboardClient initialPlan={plan} />
    </div>
  );
}
