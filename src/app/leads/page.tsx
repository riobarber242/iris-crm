export const dynamic = 'force-dynamic';

import { AdminShell } from '@/components/AdminShell';
import { SectionCard } from '@/components/ui/SectionCard';
import { StatCard } from '@/components/ui/StatCard';
import { supabaseAdmin } from '@/lib/db';

async function fetchLeads() {
  const { data } = await supabaseAdmin
    .from('leads')
    .select('id, score, reason, qualified_at, contacts(name, phone)')
    .order('qualified_at', { ascending: false });
  return data ?? [];
}

export default async function LeadsPage() {
  const leads = await fetchLeads();
  const vip = leads.filter((l: any) => l.score === 'vip').length;
  const activo = leads.filter((l: any) => l.score === 'activo').length;
  const frio = leads.filter((l: any) => l.score === 'frio').length;

  return (
    <AdminShell>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
        <SectionCard title="Leads" description="Clasificación automática según recargas y actividad.">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '16px' }}>
            <StatCard label="VIP" value={`${vip}`} />
            <StatCard label="Activo" value={`${activo}`} />
            <StatCard label="Frío" value={`${frio}`} />
          </div>
        </SectionCard>

        <SectionCard title="Detalle de leads" description="Contactos y razón de clasificación.">
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {leads.map((lead: any) => (
              <div
                key={lead.id}
                style={{
                  background: '#F5F5F5',
                  borderRadius: '14px',
                  padding: '14px 18px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '12px',
                  flexWrap: 'wrap',
                }}
              >
                <div>
                  <p style={{ fontSize: '14px', fontWeight: 700, color: '#000', margin: 0 }}>
                    {lead.contacts?.name || lead.contacts?.phone}
                  </p>
                  <p style={{ fontSize: '12px', color: '#999', margin: '2px 0 0 0' }}>{lead.reason ?? 'Sin motivo'}</p>
                  <p style={{ fontSize: '11px', color: '#bbb', margin: '2px 0 0 0' }}>
                    {new Date(lead.qualified_at).toLocaleDateString('es-AR')}
                  </p>
                </div>
                <span
                  style={{
                    background: lead.score === 'vip' ? '#C8FF00' : lead.score === 'activo' ? '#C8FF00' : '#F0F0F0',
                    color: lead.score === 'frio' ? '#888' : '#000',
                    borderRadius: '999px',
                    padding: '4px 14px',
                    fontSize: '11px',
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                  }}
                >
                  {lead.score}
                </span>
              </div>
            ))}
          </div>
        </SectionCard>
      </div>
    </AdminShell>
  );
}
