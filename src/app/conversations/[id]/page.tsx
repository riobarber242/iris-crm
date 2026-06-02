export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { AdminShell } from '@/components/AdminShell';
import { supabaseAdmin } from '@/lib/db';
import ChatWindow from '@/components/ChatWindow';
import ContactHeader from '@/components/ContactHeader';

async function fetchContact(id: string) {
  const { data, error } = await supabaseAdmin
    .from('contacts')
    .select('id, name, phone, status, blocked, casino_username, conversation_state, notes, messages(content, created_at, role)')
    .eq('id', id)
    .single();

  if (error) return null;
  return data;
}

async function fetchRecargasResumen(contactId: string) {
  const { data } = await supabaseAdmin
    .from('comprobantes')
    .select('monto')
    .eq('contact_id', contactId)
    .eq('estado', 'verificado');

  const items = data ?? [];
  return {
    count:      items.length,
    montoTotal: items.reduce((s: number, r: any) => s + Number(r.monto ?? 0), 0),
  };
}

export default async function ConversationPage({ params }: any) {
  const id = params.id as string;

  // Mark as read server-side so badge clears on next poll
  await supabaseAdmin
    .from('contacts')
    .update({ last_read_at: new Date().toISOString() })
    .eq('id', id);

  const [contact, recargas] = await Promise.all([
    fetchContact(id),
    fetchRecargasResumen(id),
  ]);

  if (!contact) {
    return (
      <AdminShell>
        <div style={{ padding: '32px', textAlign: 'center', color: '#999' }}>Contacto no encontrado.</div>
      </AdminShell>
    );
  }

  return (
    <AdminShell>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

        {/* Back button */}
        <div>
          <Link
            href="/conversations"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              fontSize: '14px',
              fontWeight: 600,
              color: '#555',
              textDecoration: 'none',
              background: '#fff',
              border: '1px solid #e0e0e0',
              borderRadius: '10px',
              padding: '7px 14px',
            }}
          >
            ← Conversaciones
          </Link>
        </div>

        <ContactHeader
          contactId={contact.id}
          phone={contact.phone}
          initialCasinoUsername={contact.casino_username}
          initialBlocked={contact.blocked ?? false}
          initialStatus={contact.status ?? 'nuevo'}
          conversationState={contact.conversation_state ?? null}
          initialNotes={contact.notes ?? ''}
          recargasCount={recargas.count}
          recargasMonto={recargas.montoTotal}
        />

        <ChatWindow contactId={contact.id} />

      </div>
    </AdminShell>
  );
}
