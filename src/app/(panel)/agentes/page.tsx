export const dynamic = 'force-dynamic';

import AgentsClient from '@/components/AgentsClient';
import { requireFeaturePage } from '@/lib/plan-guard';

export default async function AgentesPage() {
  // En los planes de una sola cuenta compartida, esta sección no existe.
  await requireFeaturePage('operadores');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div>
        <h1 style={{ fontSize: '22px', fontWeight: 900, color: '#000', margin: 0 }}>Operadores</h1>
        <p style={{ fontSize: '13px', color: '#999', margin: '4px 0 0 0' }}>
          Crear, editar, activar/desactivar operadores y resetear contraseñas.
        </p>
      </div>
      <AgentsClient />
    </div>
  );
}
