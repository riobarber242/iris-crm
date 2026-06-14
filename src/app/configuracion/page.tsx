export const dynamic = 'force-dynamic';

import { AdminShell } from '@/components/AdminShell';
import { SectionCard } from '@/components/ui/SectionCard';
import CronRunner from '@/components/CronRunner';
import AutoMsgToggle from '@/components/AutoMsgToggle';
import QuickRepliesManager from '@/components/QuickRepliesManager';
import WhatsAppNumbersManager from '@/components/WhatsAppNumbersManager';

// "Configuración": todo lo de la cuenta (números de WhatsApp, notificación de
// recarga, clasificación de contactos, respuestas rápidas). El control del bot
// (on/off, system prompt, modo offline) vive en /mi-bot ("Mi Bot").
export default function ConfiguracionPage() {
  return (
    <AdminShell>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>

        <SectionCard title="Notificación de recarga verificada" description='Envía "Tu recarga de $X fue confirmada ✅" automáticamente al verificar un comprobante.'>
          <AutoMsgToggle />
        </SectionCard>

        <SectionCard title="Clasificación de contactos" description="Forzá la actualización de estados sin esperar el cron diario.">
          <CronRunner />
        </SectionCard>

        <SectionCard title="Respuestas rápidas" description="Plantillas de mensajes predefinidas. Usalas desde el chat con el botón ⚡.">
          <QuickRepliesManager />
        </SectionCard>

        <WhatsAppNumbersManager />

      </div>
    </AdminShell>
  );
}
