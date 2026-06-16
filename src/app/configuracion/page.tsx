export const dynamic = 'force-dynamic';

import { AdminShell } from '@/components/AdminShell';
import { SectionCard } from '@/components/ui/SectionCard';
import CronRunner from '@/components/CronRunner';
import AutoMsgToggle from '@/components/AutoMsgToggle';
import QuickRepliesManager from '@/components/QuickRepliesManager';
import WhatsAppNumbersManager from '@/components/WhatsAppNumbersManager';
import CajaConfigManager from '@/components/CajaConfigManager';
import ChangePasswordCard from '@/components/ChangePasswordCard';
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

  return (
    <AdminShell>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>

        {showAccountConfig && (
          <>
            <SectionCard title="Notificación de recarga verificada" description='Envía "Tu recarga de $X fue confirmada ✅" automáticamente al verificar un comprobante.'>
              <AutoMsgToggle />
            </SectionCard>

            <SectionCard title="Clasificación de contactos" description="Forzá la actualización de estados sin esperar el cron diario.">
              <CronRunner />
            </SectionCard>

            <SectionCard title="Respuestas rápidas" description="Plantillas de mensajes predefinidas. Usalas desde el chat con el botón ⚡.">
              <QuickRepliesManager />
            </SectionCard>

            <SectionCard title="Caja: descargas y sueldos" description="WhatsApp del agente para descargas y el sueldo diario que cobra cada operador.">
              <CajaConfigManager />
            </SectionCard>

            <WhatsAppNumbersManager />
          </>
        )}

        {showChangePassword && <ChangePasswordCard />}

      </div>
    </AdminShell>
  );
}
