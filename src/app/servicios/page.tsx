export const dynamic = 'force-dynamic';

import { AdminShell } from '@/components/AdminShell';
import ServicesClient from '@/components/ServicesClient';

// Acceso admin-only controlado por el middleware (/servicios en ADMIN_ONLY_PREFIXES).
export default function ServiciosPage() {
  return (
    <AdminShell>
      {/* Fondo oscuro casi-negro para que resalten las cards navy.
          margin/padding negativos para cubrir todo el área de contenido del shell. */}
      <div style={{
        background: '#0F1923',
        margin: '-24px',
        padding: '24px',
        minHeight: 'calc(100vh - 80px)',
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <div>
            <h1 style={{ fontSize: '22px', fontWeight: 900, color: '#FFFFFF', margin: 0 }}>Servicios &amp; Pagos</h1>
            <p style={{ fontSize: '13px', color: 'rgba(255,255,255,0.5)', margin: '4px 0 0 0' }}>
              Estado y vencimientos de los servicios de la plataforma.
            </p>
          </div>
          <ServicesClient />
        </div>
      </div>
    </AdminShell>
  );
}
