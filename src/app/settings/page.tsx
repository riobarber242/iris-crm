export const dynamic = 'force-dynamic';

import { AdminShell } from '@/components/AdminShell';
import { SectionCard } from '@/components/ui/SectionCard';
import BotToggle from '@/components/BotToggle';
import CronRunner from '@/components/CronRunner';
import SystemPromptEditor from '@/components/SystemPromptEditor';
import { supabaseAdmin } from '@/lib/db';

async function fetchSettings() {
  const { data } = await supabaseAdmin.from('settings').select('*');
  return data ?? [];
}

export default async function SettingsPage() {
  const settings = await fetchSettings();

  return (
    <AdminShell>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>

        <SectionCard title="Control del bot" description="Activá o pausá el bot automático de WhatsApp.">
          <BotToggle />
        </SectionCard>

        <SectionCard title="Clasificación de contactos" description="Forzá la actualización de estados sin esperar el cron diario.">
          <CronRunner />
        </SectionCard>

        <SectionCard title="Prompt del bot" description="Texto base que define la personalidad y reglas de Iris. Se guarda en la base de datos y tiene prioridad sobre el código.">
          <SystemPromptEditor />
        </SectionCard>

        <SectionCard title="Variables de sistema" description="Configuración interna del CRM.">
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {settings.map((item: any) => (
              <div
                key={item.key}
                style={{
                  background: '#F5F5F5',
                  borderRadius: '14px',
                  padding: '14px 18px',
                }}
              >
                <p
                  style={{
                    fontSize: '11px',
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: '0.1em',
                    color: '#999',
                    margin: '0 0 6px 0',
                  }}
                >
                  {item.key}
                </p>
                <p style={{ fontSize: '14px', color: '#000', margin: 0, wordBreak: 'break-all' }}>{item.value}</p>
              </div>
            ))}
          </div>
        </SectionCard>

      </div>
    </AdminShell>
  );
}
