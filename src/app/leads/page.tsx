export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { AdminShell } from '@/components/AdminShell';
import { SectionCard } from '@/components/ui/SectionCard';
import { supabaseAdmin } from '@/lib/db';

type TopClient = {
  contact_id: string;
  total: number;
  monto_total: number;
  phone: string;
  casino_username: string | null;
  status: string;
};

async function fetchTopClients(): Promise<TopClient[]> {
  // Comprobantes verificados agrupados por contacto
  const { data: comprobantes } = await supabaseAdmin
    .from('comprobantes')
    .select('contact_id, monto')
    .eq('estado', 'verificado');

  if (!comprobantes || comprobantes.length === 0) return [];

  // Aggregate by contact_id
  const map = new Map<string, { total: number; monto: number }>();
  for (const c of comprobantes) {
    const prev = map.get(c.contact_id) ?? { total: 0, monto: 0 };
    map.set(c.contact_id, {
      total: prev.total + 1,
      monto: prev.monto + Number(c.monto ?? 0),
    });
  }

  const ids = Array.from(map.keys());
  const { data: contacts } = await supabaseAdmin
    .from('contacts')
    .select('id, phone, casino_username, status')
    .in('id', ids);

  const contactMap = new Map((contacts ?? []).map((c: any) => [c.id, c]));

  const result: TopClient[] = Array.from(map.entries()).map(([id, agg]) => {
    const contact = contactMap.get(id) as any;
    return {
      contact_id:     id,
      total:          agg.total,
      monto_total:    agg.monto,
      phone:          contact?.phone ?? '—',
      casino_username: contact?.casino_username ?? null,
      status:         contact?.status ?? '—',
    };
  });

  return result.sort((a, b) => b.monto_total - a.monto_total);
}

const STATUS_STYLE: Record<string, React.CSSProperties> = {
  cliente_activo: { background: '#C8FF00', color: '#000' },
  inactivo:       { background: '#888',    color: '#fff' },
  nuevo:          { background: '#F0F0F0', color: '#888' },
};

export default async function LeadsPage() {
  const clients = await fetchTopClients();
  const totalMonto = clients.reduce((s, c) => s + c.monto_total, 0);

  return (
    <AdminShell>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>

        <div>
          <h1 style={{ fontSize: '22px', fontWeight: 900, color: '#000', margin: 0 }}>Top clientes</h1>
          <p style={{ fontSize: '13px', color: '#999', margin: '4px 0 0 0' }}>
            Contactos ordenados por monto total de recargas verificadas.
          </p>
        </div>

        {/* Summary cards */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px' }}>
          {[
            { label: 'Clientes con recargas', value: clients.length },
            { label: 'Total comprobantes',    value: clients.reduce((s, c) => s + c.total, 0) },
            { label: 'Monto total verificado', value: `$${totalMonto.toLocaleString('es-AR')}` },
          ].map((card) => (
            <div key={card.label} style={{
              background: '#fff', borderRadius: '14px', padding: '16px 18px',
              boxShadow: '0 1px 8px rgba(0,0,0,0.06)',
            }}>
              <p style={{ fontSize: '11px', fontWeight: 700, color: '#aaa', textTransform: 'uppercase', letterSpacing: '0.08em', margin: 0 }}>
                {card.label}
              </p>
              <p style={{ fontSize: '28px', fontWeight: 900, color: '#000', margin: '6px 0 0 0', lineHeight: 1 }}>
                {card.value}
              </p>
            </div>
          ))}
        </div>

        <SectionCard title="Ranking de clientes" description="Por monto total de recargas verificadas.">
          {clients.length === 0 ? (
            <p style={{ color: '#999', fontSize: '14px', textAlign: 'center', padding: '24px 0' }}>
              No hay comprobantes verificados aún.
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {/* Header */}
              <div style={{
                display: 'grid', gridTemplateColumns: '32px 1fr 1fr 90px 100px 90px 36px',
                gap: '12px', padding: '6px 14px',
                fontSize: '11px', fontWeight: 700, color: '#aaa', textTransform: 'uppercase', letterSpacing: '0.06em',
              }}>
                <span>#</span>
                <span>Usuario</span>
                <span>Teléfono</span>
                <span>Estado</span>
                <span>Recargas</span>
                <span>Monto total</span>
                <span />
              </div>

              {clients.map((c, i) => {
                const name = c.casino_username || c.phone;
                const st   = STATUS_STYLE[c.status] ?? STATUS_STYLE.nuevo;
                return (
                  <div key={c.contact_id} style={{
                    display: 'grid', gridTemplateColumns: '32px 1fr 1fr 90px 100px 90px 36px',
                    gap: '12px', alignItems: 'center',
                    background: i === 0 ? '#fffde7' : '#fff',
                    borderRadius: '14px', padding: '12px 14px',
                    boxShadow: '0 1px 6px rgba(0,0,0,0.06)',
                    border: i === 0 ? '1px solid #f0c040' : 'none',
                  }}>
                    <span style={{ fontSize: '13px', fontWeight: 900, color: i < 3 ? '#b8860b' : '#ccc' }}>
                      {i + 1}
                    </span>
                    <p style={{ margin: 0, fontSize: '14px', fontWeight: 700, color: '#000', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {c.casino_username ? `🎰 ${c.casino_username}` : c.phone}
                    </p>
                    <p style={{ margin: 0, fontSize: '13px', color: '#888' }}>{c.phone}</p>
                    <span style={{
                      ...st, fontSize: '11px', fontWeight: 700, textTransform: 'uppercase',
                      letterSpacing: '0.04em', borderRadius: '999px', padding: '3px 10px',
                      display: 'inline-block', textAlign: 'center',
                    }}>
                      {c.status}
                    </span>
                    <p style={{ margin: 0, fontSize: '14px', fontWeight: 700, color: '#000', textAlign: 'center' }}>
                      {c.total} ✓
                    </p>
                    <p style={{ margin: 0, fontSize: '15px', fontWeight: 900, color: '#000' }}>
                      ${c.monto_total.toLocaleString('es-AR')}
                    </p>
                    <Link href={`/conversations/${c.contact_id}`} style={{ textDecoration: 'none' }}>
                      <div style={{
                        width: '32px', height: '32px', borderRadius: '8px', background: '#1a1a1a',
                        display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '15px', cursor: 'pointer',
                      }} title="Ir a conversación">
                        💬
                      </div>
                    </Link>
                  </div>
                );
              })}
            </div>
          )}
        </SectionCard>

      </div>
    </AdminShell>
  );
}
