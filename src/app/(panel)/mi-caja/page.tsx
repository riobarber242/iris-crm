export const dynamic = 'force-dynamic';

import { SectionCard } from '@/components/ui/SectionCard';
import MiCajaClient from '@/components/MiCajaClient';

export default function MiCajaPage() {
  return (
    <div className="space-y-8">
      <SectionCard title="Mi Caja" description="Tu billetera, el pozo de fichas y tus movimientos. Solo lectura.">
        <MiCajaClient />
      </SectionCard>
    </div>
  );
}
