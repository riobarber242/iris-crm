export const dynamic = 'force-dynamic';

import ContactsClient from '@/components/ContactsClient';
import { supabaseAdmin } from '@/lib/db';
import { getSessionAgent } from '@/lib/current-agent';

function fmt(n: number) {
  return n.toLocaleString('es-AR');
}

export default async function ContactsPage() {
  // Contadores SCOPEADOS al tenant del usuario logueado (igual que la lista).
  // agendados = contactos del tenant con casino_username; total = todos los del
  // tenant. Sin sesión (caso de borde; el middleware ya exige login) → 0, para
  // nunca contar contactos de otros tenants.
  const session = await getSessionAgent();
  let agendados = 0;
  let total     = 0;
  if (session) {
    const [agendadosRes, totalRes] = await Promise.all([
      supabaseAdmin.from('contacts').select('id', { count: 'exact', head: true })
        .eq('tenant_id', session.tenant_id)
        .not('casino_username', 'is', null).neq('casino_username', ''),
      supabaseAdmin.from('contacts').select('id', { count: 'exact', head: true })
        .eq('tenant_id', session.tenant_id),
    ]);
    agendados = agendadosRes.count ?? 0;
    total     = totalRes.count     ?? 0;
  }

  return (
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
  );
}
