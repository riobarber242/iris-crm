export const dynamic = 'force-dynamic';

import LeadsClient from '@/components/LeadsClient';
import { requireFeaturePage } from '@/lib/plan-guard';

export default async function LeadsPage() {
  await requireFeaturePage('top_clientes');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>

      <div>
        <h1 style={{ fontSize: '22px', fontWeight: 900, color: '#000', margin: 0 }}>Top clientes</h1>
        <p style={{ fontSize: '13px', color: '#999', margin: '4px 0 0 0' }}>
          Ranking por total cargado. Los pagos se muestran aparte y no afectan el orden.
        </p>
      </div>

      <LeadsClient />

    </div>
  );
}
