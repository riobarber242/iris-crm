export const dynamic = 'force-dynamic';

import { AdminShell } from '@/components/AdminShell';
import ContactsClient from '@/components/ContactsClient';
import { supabaseAdmin } from '@/lib/db';

function fmt(n: number) {
  return n.toLocaleString('es-AR');
}

export default async function ContactsPage() {
  // agendados = mismo filtro que la lista (casino_username asignado); total = todos los contactos en DB
  const [agendadosRes, totalRes] = await Promise.all([
    supabaseAdmin.from('contacts').select('id', { count: 'exact', head: true })
      .not('casino_username', 'is', null).neq('casino_username', ''),
    supabaseAdmin.from('contacts').select('id', { count: 'exact', head: true }),
  ]);
  const agendados = agendadosRes.count ?? 0;
  const total     = totalRes.count     ?? 0;

  return (
    <AdminShell>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
        <div>
          <h1 style={{ fontSize: '22px', fontWeight: 900, color: '#000', margin: 0 }}>
            Contactos agendados ({fmt(agendados)})
          </h1>
          <p style={{ fontSize: '13px', color: '#999', margin: '4px 0 0 0' }}>
            {fmt(agendados)} agendados · {fmt(total)} en base de datos total
          </p>
        </div>
        <ContactsClient />
      </div>
    </AdminShell>
  );
}
