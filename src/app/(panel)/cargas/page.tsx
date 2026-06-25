export const dynamic = 'force-dynamic';

import { SectionCard } from '@/components/ui/SectionCard';
import ComprobantesClient from '@/components/ComprobantesClient';
import { getSessionAgent } from '@/lib/current-agent';

export default async function CargasPage() {
  const session = await getSessionAgent();
  // Solo admin/agent pueden eliminar comprobantes.
  const canDelete = session?.role === 'admin' || session?.role === 'agent';

  return (
    <div className="space-y-8">
      <SectionCard title="Cargas" description="Revisá y verificá las cargas que los operadores envían desde las conversaciones.">
        <ComprobantesClient tipo="carga" canDelete={canDelete} />
      </SectionCard>
    </div>
  );
}
