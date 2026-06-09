export const dynamic = 'force-dynamic';

import { AdminShell } from '@/components/AdminShell';
import { SectionCard } from '@/components/ui/SectionCard';
import BotConfigEditor from '@/components/BotConfigEditor';

// Panel self-service del agente para editar el system prompt de su bot,
// sin pasar por el admin. El acceso (admin + agent, sin operator) lo controla
// el middleware vía /configuracion en STAFF_PREFIXES.
export default function ConfiguracionPage() {
  return (
    <AdminShell>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
        <SectionCard
          title="System Prompt de tu Bot"
          description="Configurá la personalidad y las reglas de tu asistente automático de WhatsApp. El bot usa este texto como base cuando responde a tus clientes."
        >
          <BotConfigEditor />
        </SectionCard>
      </div>
    </AdminShell>
  );
}
