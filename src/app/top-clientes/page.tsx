export const dynamic = 'force-dynamic';

import { AdminShell } from '@/components/AdminShell';
import LeadsClient from '@/components/LeadsClient';

export default function LeadsPage() {
  return (
    <AdminShell>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>

        <div>
          <h1 style={{ fontSize: '22px', fontWeight: 900, color: '#000', margin: 0 }}>Top clientes</h1>
          <p style={{ fontSize: '13px', color: '#999', margin: '4px 0 0 0' }}>
            Contactos ordenados por monto total de recargas verificadas.
          </p>
        </div>

        <LeadsClient />

      </div>
    </AdminShell>
  );
}
