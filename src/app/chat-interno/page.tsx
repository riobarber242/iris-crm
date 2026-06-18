export const dynamic = 'force-dynamic';

import { AdminShell } from '@/components/AdminShell';
import { SectionCard } from '@/components/ui/SectionCard';
import InternalChatClient from '@/components/InternalChatClient';
import { getSessionAgent } from '@/lib/current-agent';

// Chat interno del equipo (Etapa 1). Sala grupal por tenant: agente + sus
// operadores. NO sale a WhatsApp/Meta. El admin de plataforma NO participa
// (defensa server-side, además del filtrado del menú en AdminShell).
export default async function ChatInternoPage() {
  const session = await getSessionAgent();
  const isMember = session?.role === 'agent' || session?.role === 'operator';

  return (
    <AdminShell>
      {isMember ? (
        // Alto acotado a la pantalla: el chat fija su caja abajo y solo el área
        // de mensajes scrollea (no usa SectionCard para poder ocupar el alto).
        <div className="chat-page-fill">
          <InternalChatClient />
        </div>
      ) : (
        <div className="space-y-8">
          <SectionCard title="Chat interno" description="Sala del equipo (agente y operadores). Privada de tu cuenta, no se envía a los clientes.">
            <div style={{ padding: '32px', textAlign: 'center', color: '#999' }}>
              El chat interno es para agentes y operadores del equipo.
            </div>
          </SectionCard>
        </div>
      )}
    </AdminShell>
  );
}
