export const dynamic = 'force-dynamic';

import { AdminShell } from '@/components/AdminShell';
import { SectionCard } from '@/components/ui/SectionCard';
import BotToggle from '@/components/BotToggle';
import BotConfigEditor from '@/components/BotConfigEditor';
import OfflineConfig from '@/components/OfflineConfig';

// "Mi Bot": todo lo del bot del agente (on/off, system prompt, modo offline).
// El acceso (admin + agent, sin operator) lo controla el middleware vía
// /mi-bot en STAFF_PREFIXES. La administración de la cuenta (números de
// WhatsApp, etc.) vive en /configuracion ("Configuración").
export default function MiBotPage() {
  return (
    <AdminShell>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
        <SectionCard title="Control del bot" description="Activá o pausá el bot automático de WhatsApp.">
          <BotToggle />
        </SectionCard>

        <SectionCard
          title="System Prompt de tu Bot"
          description="Configurá la personalidad y las reglas de tu asistente automático de WhatsApp. El bot usa este texto como base cuando responde a tus clientes."
        >
          <BotConfigEditor />
        </SectionCard>

        <SectionCard
          title="Modo offline"
          description="Cuando lo activás, el bot deja de atender y responde a todos los clientes con un único mensaje fijo."
        >
          <OfflineConfig />
        </SectionCard>
      </div>
    </AdminShell>
  );
}
