import { AdminShell } from '@/components/AdminShell';
import { SectionCard } from '@/components/ui/SectionCard';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { supabaseAdmin } from '@/lib/db';

async function fetchConversations() {
  const { data } = await supabaseAdmin
    .from('contacts')
    .select('id, name, phone, status, blocked, created_at, messages(content, created_at, role)')
    .order('created_at', { ascending: false });

  return data ?? [];
}

export default async function ConversationsPage() {
  const conversations = await fetchConversations();

  return (
    <AdminShell>
      <div className="space-y-8">
        <SectionCard title="Conversaciones" description="Lista de contactos recientes y su último mensaje.">
          <div className="space-y-4">
            {conversations.map((contact: any) => {
              const lastMessage = contact.messages?.[0];
              return (
                <div key={contact.id} className="rounded-[28px] border border-white/10 bg-[#14141c] p-5">
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-lg font-semibold text-white">{contact.name || contact.phone}</p>
                      <p className="text-sm text-iris-text-muted">{contact.phone}</p>
                    </div>
                    <div className="flex items-center gap-3">
                      <StatusBadge status={contact.status} />
                      {contact.blocked ? <span className="rounded-full bg-[#431b2e] px-3 py-1 text-xs text-iris-pink">Bloqueado</span> : null}
                    </div>
                  </div>
                  <div className="mt-4 flex flex-col gap-2 rounded-3xl bg-iris-card p-4">
                    <p className="text-sm text-iris-text-muted">Último mensaje:</p>
                    <p className="text-base text-white">{lastMessage ? lastMessage.content : 'Sin mensajes aún'}</p>
                    <p className="text-xs text-iris-text-muted">{lastMessage ? new Date(lastMessage.created_at).toLocaleString('es-AR') : ''}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </SectionCard>
      </div>
    </AdminShell>
  );
}
