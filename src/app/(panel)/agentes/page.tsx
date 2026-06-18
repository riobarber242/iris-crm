export const dynamic = 'force-dynamic';

import AgentsClient from '@/components/AgentsClient';

export default function AgentesPage() {
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
