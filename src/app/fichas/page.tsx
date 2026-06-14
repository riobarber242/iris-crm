export const dynamic = 'force-dynamic';

import { AdminShell } from '@/components/AdminShell';
import { SectionCard } from '@/components/ui/SectionCard';
import FichasClient from '@/components/FichasClient';

export default function FichasPage() {
  return (
    <AdminShell>
      <div className="space-y-8">
        <SectionCard title="Fichas" description="Pozo de fichas, recargas y movimientos de caja.">
          <FichasClient />
        </SectionCard>
      </div>
    </AdminShell>
  );
}
