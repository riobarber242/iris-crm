export const dynamic = 'force-dynamic';

import { SectionCard } from '@/components/ui/SectionCard';
import ComprobantesClient from '@/components/ComprobantesClient';
import { getSessionAgent } from '@/lib/current-agent';

export default async function PagosPage() {
  const session = await getSessionAgent();
  // Solo admin/agent pueden cargar pagos manuales (premios pagados por afuera) y
  // eliminar comprobantes.
  const canManualPago = session?.role === 'admin' || session?.role === 'agent';
  const canDelete     = session?.role === 'admin' || session?.role === 'agent';

  return (
    <div className="space-y-8">
      <SectionCard title="Pagos" description="Verificá los pagos enviados desde las conversaciones. Al verificar, suben fichas al pozo y baja la billetera del operador.">
        <ComprobantesClient tipo="pago" canManualPago={canManualPago} canDelete={canDelete} />
      </SectionCard>
    </div>
  );
}
