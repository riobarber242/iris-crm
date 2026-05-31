import { AdminShell } from '@/components/AdminShell';
import { supabaseAdmin } from '@/lib/db';

async function fetchContact(id: string) {
  const { data, error } = await supabaseAdmin
    .from('contacts')
    .select('id, name, phone, status, blocked, messages(content, created_at, role)')
    .eq('id', id)
    .single();

  if (error) return null;
  return data;
}

export default async function ConversationPage({ params }: { params: { id: string } }) {
  const contact = await fetchContact(params.id);

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
          <div>
            <h2 className="text-2xl font-semibold text-white">{contact.name || contact.phone}</h2>
            <p className="text-sm text-iris-text-muted">{contact.phone}</p>
          </div>
        </div>

        <div className="space-y-3">
          {messages.length === 0 ? (
            <p className="text-iris-text-muted">No hay mensajes aún.</p>
          ) : (
            messages.map((m: any, idx: number) => (
              <div key={idx} className="rounded-lg bg-iris-card p-3">
                <p className="text-sm text-iris-text-muted">{m.role}</p>
                <p className="text-white">{m.content}</p>
                <p className="text-xs text-iris-text-muted">{new Date(m.created_at).toLocaleString('es-AR')}</p>
              </div>
            ))
          )}
        </div>
      </div>
    </AdminShell>
  );
}
