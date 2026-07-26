export const dynamic = 'force-dynamic';

import { SectionCard } from '@/components/ui/SectionCard';
import FichasClient from '@/components/FichasClient';
import { requireFeaturePage } from '@/lib/plan-guard';

export default async function FichasPage() {
  await requireFeaturePage('caja');

  return (
    <div className="space-y-8">
      <SectionCard title="Fichas" description="Pozo de fichas, recargas y movimientos de caja.">
        <FichasClient />
      </SectionCard>
    </div>
  );
}
