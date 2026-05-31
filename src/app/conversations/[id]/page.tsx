export const dynamic = 'force-dynamic';

import { AdminShell } from '@/components/AdminShell';
import { supabaseAdmin } from '@/lib/db';
import ChatWindow from '@/components/ChatWindow';
import ContactHeader from '@/components/ContactHeader';

async function fetchContact(id: string) {
  const { data, error } = await supabaseAdmin
    .from('contacts')
    .select('id, name, phone, status, blocked, messages(content, created_at, role)')
    .eq('id', id)
    .single();

  if (error) return null;
  return data;
}

export default async function ConversationPage({ params }: any) {
  const contact = await fetchContact(params.id as string);

  if (!contact) {
    return (
      <AdminShell>
        <div className="py-10 text-center text-white">Contacto no encontrado.</div>
      </AdminShell>
    );
  }

  const messages = contact.messages ?? [];

  return (
    <AdminShell>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <ContactHeader contactId={contact.id} initialName={contact.name} phone={contact.phone} />
        </div>

        <div>
          <ChatWindow contactId={contact.id} />
        </div>
      </div>
    </AdminShell>
  );
}
