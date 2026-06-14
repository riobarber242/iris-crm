export const dynamic = 'force-dynamic';

import { AdminShell } from '@/components/AdminShell';
import { SectionCard } from '@/components/ui/SectionCard';
import ConversationsClient from '@/components/ConversationsClient';

export default async function ConversationsPage() {
  return (
    <AdminShell>
      <div className="space-y-8">
        <SectionCard title="Conversaciones" description="Lista de contactos recientes y su último mensaje.">
          <div className="space-y-4">
            <ConversationsClient />
          </div>
        </SectionCard>
      </div>
    </AdminShell>
  );
}
