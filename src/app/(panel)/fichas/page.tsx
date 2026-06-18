export const dynamic = 'force-dynamic';

import { SectionCard } from '@/components/ui/SectionCard';
import FichasClient from '@/components/FichasClient';

export default function FichasPage() {
  return (
    <div className="space-y-8">
      <SectionCard title="Fichas" description="Pozo de fichas, recargas y movimientos de caja.">
        <FichasClient />
      </SectionCard>
    </div>
  );
}
