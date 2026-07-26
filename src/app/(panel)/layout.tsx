import type { ReactNode } from 'react';
import { AdminShell } from '@/components/AdminShell';
import { getSessionAgent } from '@/lib/current-agent';
import { planForTenant } from '@/lib/plan-guard';

// Layout compartido de todo el panel autenticado. AdminShell (header + sidebar)
// vive acá UNA sola vez: al navegar entre secciones el shell ya no se desmonta
// ni se vuelve a montar, así que no re-dispara sus fetches/suscripciones y la
// navegación se siente instantánea. Solo cambia el contenido (`children`).
// Login y la home quedan FUERA de este grupo a propósito (sin shell).
export default async function PanelLayout({ children }: { children: ReactNode }) {
  // El plan se resuelve en el SERVIDOR y baja como prop. AdminShell tambien lo
  // tiene por /api/auth/me, pero eso llega despues de hidratar: sin esta prop,
  // el primer render de un cliente Lite sale con el plan desconocido (que se
  // trata como premium) y se ve un parpadeo con el logo y los items del menu de
  // otro plan. El de /me sigue mandando despues, para reflejar un cambio de
  // plan sin recargar.
  const session = await getSessionAgent();
  const plan    = session ? await planForTenant(session.tenant_id) : null;

  return <AdminShell initialPlan={plan}>{children}</AdminShell>;
}
