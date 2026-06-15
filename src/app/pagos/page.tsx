export const dynamic = 'force-dynamic';

import { AdminShell } from '@/components/AdminShell';
import { SectionCard } from '@/components/ui/SectionCard';
import ComprobantesClient from '@/components/ComprobantesClient';
import { getSessionAgent } from '@/lib/current-agent';

export default async function PagosPage() {
  const session = await getSessionAgent();
  // Solo admin/agent pueden cargar pagos manuales (premios pagados por afuera).
  const canManualPago = session?.role === 'admin' || session?.role === 'agent';

  return (
    <AdminShell>
      <div className="space-y-8">
        <SectionCard title="Pagos" description="Verificá los pagos enviados desde las conversaciones. Al verificar, suben fichas al pozo y baja la billetera del operador.">
          <ComprobantesClient tipo="pago" canManualPago={canManualPago} />
        </SectionCard>
      </div>
    </AdminShell>
  );
}
