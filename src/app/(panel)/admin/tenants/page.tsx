export const dynamic = 'force-dynamic';

import TenantsClient from '@/components/TenantsClient';

export default function TenantsPage() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div>
        <h1 style={{ fontSize: '22px', fontWeight: 900, color: '#000', margin: 0 }}>Agentes</h1>
        <p style={{ fontSize: '13px', color: '#999', margin: '4px 0 0 0' }}>
          Tus clientes que usan IRIS Premium.
        </p>
      </div>
      <TenantsClient />
    </div>
  );
}
