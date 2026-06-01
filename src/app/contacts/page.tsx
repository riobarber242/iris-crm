export const dynamic = 'force-dynamic';

import { AdminShell } from '@/components/AdminShell';
import ContactsClient from '@/components/ContactsClient';

export default function ContactsPage() {
  return (
    <AdminShell>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
        <div>
          <h1 style={{ fontSize: '22px', fontWeight: 900, color: '#000', margin: 0 }}>Contactos agendados</h1>
          <p style={{ fontSize: '13px', color: '#999', margin: '4px 0 0 0' }}>
            Todos los contactos con nombre asignado por un operador.
          </p>
        </div>
        <ContactsClient />
      </div>
    </AdminShell>
  );
}
