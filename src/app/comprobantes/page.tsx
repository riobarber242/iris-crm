export const dynamic = 'force-dynamic';

import { AdminShell } from '@/components/AdminShell';
import { SectionCard } from '@/components/ui/SectionCard';
import ComprobantesClient from '@/components/ComprobantesClient';

export default function ComprobantesPage() {
  return (
    <AdminShell>
      <div className="space-y-8">
        <SectionCard title="Comprobantes" description="Revisá y gestioná recibos pendientes desde el panel.">
          <ComprobantesClient />
        </SectionCard>
      </div>
    </AdminShell>
  );
}
