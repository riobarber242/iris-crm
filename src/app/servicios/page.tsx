export const dynamic = 'force-dynamic';

import { AdminShell } from '@/components/AdminShell';
import ServicesClient from '@/components/ServicesClient';

// Acceso admin-only controlado por el middleware (/servicios en ADMIN_ONLY_PREFIXES).
export default function ServiciosPage() {
  return (
    <AdminShell>
      {/* Fondo gris muy claro (estilo Lemon) para que resalten las cards celeste neón.
          margin/padding negativos para cubrir todo el área de contenido del shell. */}
      <div style={{
        background: '#F5F5F5',
        margin: '-24px',
        padding: '24px',
        minHeight: 'calc(100vh - 80px)',
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <div>
            <h1 style={{ fontSize: '22px', fontWeight: 900, color: '#1A1A2E', margin: 0 }}>Servicios &amp; Pagos</h1>
            <p style={{ fontSize: '13px', color: '#1A1A2E', opacity: 0.6, margin: '4px 0 0 0' }}>
              Estado y vencimientos de los servicios de la plataforma.
            </p>
          </div>
          <ServicesClient />
        </div>
      </div>
    </AdminShell>
  );
}
