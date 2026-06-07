export const dynamic = 'force-dynamic';

import { AdminShell } from '@/components/AdminShell';
import TenantsClient from '@/components/TenantsClient';

export default function TenantsPage() {
  return (
    <AdminShell>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
        <div>
          <h1 style={{ fontSize: '22px', fontWeight: 900, color: '#000', margin: 0 }}>Tenants</h1>
          <p style={{ fontSize: '13px', color: '#999', margin: '4px 0 0 0' }}>
            Crear y editar tenants (negocios). Cada tenant puede tener su propio número de WhatsApp (Phone ID + Access Token).
          </p>
        </div>
        <TenantsClient />
      </div>
    </AdminShell>
  );
}
