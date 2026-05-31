export const dynamic = 'force-dynamic';

import { AdminShell } from '@/components/AdminShell';
import { SectionCard } from '@/components/ui/SectionCard';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { supabaseAdmin } from '@/lib/db';
import Link from 'next/link';

async function fetchConversations() {
  const { data } = await supabaseAdmin
    .from('contacts')
    .select('id, name, phone, status, blocked, created_at, messages(content, created_at, role)')
    .order('created_at', { ascending: false });
  const contacts = data ?? [];

  // fetch unread counts
  const { data: unreadMessages } = await supabaseAdmin
    .from('messages')
    .select('contact_id')
    .eq('role', 'assistant')
    .neq('status', 'read');

  const unreadMap: Record<string, number> = {};
  (unreadMessages ?? []).forEach((m: any) => {
    unreadMap[m.contact_id] = (unreadMap[m.contact_id] ?? 0) + 1;
  });

  return contacts.map((c: any) => ({ ...c, unread_count: unreadMap[c.id] ?? 0 }));
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
                <Link key={contact.id} href={`/conversations/${contact.id}`} className="block">
                  <div className="rounded-[28px] border border-white/10 bg-[#14141c] p-5 hover:shadow-lg transition">
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <p className="text-lg font-semibold text-white">{contact.name || contact.phone}</p>
                        <p className="text-sm text-iris-text-muted">{contact.phone}</p>
                      </div>
                      <div className="flex items-center gap-3">
                        <StatusBadge status={contact.status} />
                        {contact.unread_count ? (
                          <span className="ml-2 inline-flex items-center rounded-full bg-yellow-600 px-2 py-0.5 text-xs font-semibold text-black">
                            {contact.unread_count}
                          </span>
                        ) : null}
                        {contact.blocked ? <span className="rounded-full bg-[#431b2e] px-3 py-1 text-xs text-iris-pink">Bloqueado</span> : null}
                      </div>
                    </div>
                    <div className="mt-4 flex flex-col gap-2 rounded-3xl bg-iris-card p-4">
                      <p className="text-sm text-iris-text-muted">Último mensaje:</p>
                      <p className="text-base text-white">{lastMessage ? lastMessage.content : 'Sin mensajes aún'}</p>
                      <p className="text-xs text-iris-text-muted">{lastMessage ? new Date(lastMessage.created_at).toLocaleString('es-AR') : ''}</p>
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        </SectionCard>
      </div>
    </AdminShell>
  );
}
