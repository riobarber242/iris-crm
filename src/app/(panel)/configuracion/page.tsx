export const dynamic = 'force-dynamic';

import { SectionCard } from '@/components/ui/SectionCard';
import CronRunner from '@/components/CronRunner';
import AutoMsgToggle from '@/components/AutoMsgToggle';
import QuickRepliesManager from '@/components/QuickRepliesManager';
import WhatsAppNumbersManager from '@/components/WhatsAppNumbersManager';
import WhatsAppTemplatesManager from '@/components/WhatsAppTemplatesManager';
import ChangePasswordCard from '@/components/ChangePasswordCard';
import NotificationVolumeCard from '@/components/NotificationVolumeCard';
import CasinoConfigCard from '@/components/CasinoConfigCard';
import { getSessionAgent } from '@/lib/current-agent';

// "Configuración": todo lo de la cuenta (números de WhatsApp, notificación de
// recarga, clasificación de contactos, respuestas rápidas). El control del bot
// (on/off, system prompt, modo offline) vive en /mi-bot ("Mi Bot").
//
// Visibilidad por rol:
//  - admin / agent: secciones de cuenta (las de siempre).
//  - agent / operator: tarjeta "Cambiar contraseña".
//  - operator: SOLO la tarjeta de contraseña (no ve la config de la cuenta).
export default async function ConfiguracionPage() {
  const session = await getSessionAgent();
  const role = session?.role;
  const showAccountConfig = role === 'admin' || role === 'agent';
  const showChangePassword = role === 'agent' || role === 'operator';
  // Configuración del casino: SOLO rol 'agent'.
  const showCasinoConfig = role === 'agent';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>

      {showAccountConfig && (
        <>
          <SectionCard title="Notificación de recarga verificada" description="Mensaje que se envía al cliente por WhatsApp al verificar una recarga. Editable, con la variable $monto.">
            <AutoMsgToggle />
          </SectionCard>

          <SectionCard title="Clasificación de contactos" description="Forzá la actualización de estados sin esperar el cron diario.">
            <CronRunner />
          </SectionCard>

          <SectionCard title="Respuestas rápidas" description="Plantillas de mensajes predefinidas. Usalas desde el chat con el botón ⚡.">
            <QuickRepliesManager />
          </SectionCard>

          <WhatsAppNumbersManager />

          <WhatsAppTemplatesManager />
        </>
      )}

      {showCasinoConfig && (
        <SectionCard title="Configuración del casino" description="Activá la integración con el casino y configurá la URL y las credenciales del agente.">
          <CasinoConfigCard />
        </SectionCard>
      )}

      {showChangePassword && <NotificationVolumeCard />}

      {showChangePassword && <ChangePasswordCard />}

    </div>
  );
}
