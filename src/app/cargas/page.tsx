export const dynamic = 'force-dynamic';

import { AdminShell } from '@/components/AdminShell';
import { SectionCard } from '@/components/ui/SectionCard';
import ComprobantesClient from '@/components/ComprobantesClient';

export default function CargasPage() {
  return (
    <AdminShell>
      <div className="space-y-8">
        <SectionCard title="Cargas" description="Revisá y verificá las cargas que los operadores envían desde las conversaciones.">
          <ComprobantesClient tipo="carga" />
        </SectionCard>
      </div>
    </AdminShell>
  );
}
