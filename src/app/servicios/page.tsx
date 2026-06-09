export const dynamic = 'force-dynamic';

import { AdminShell } from '@/components/AdminShell';
import ServicesClient from '@/components/ServicesClient';

// Acceso admin-only controlado por el middleware (/servicios en ADMIN_ONLY_PREFIXES).
export default function ServiciosPage() {
  return (
    <AdminShell>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
        <div>
          <h1 style={{ fontSize: '22px', fontWeight: 900, color: '#000', margin: 0 }}>Servicios &amp; Pagos</h1>
          <p style={{ fontSize: '13px', color: '#999', margin: '4px 0 0 0' }}>
            Estado y vencimientos de los servicios de la plataforma.
          </p>
        </div>
        <ServicesClient />
      </div>
    </AdminShell>
  );
}
