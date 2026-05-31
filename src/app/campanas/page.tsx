export const dynamic = 'force-dynamic';

import { AdminShell } from '@/components/AdminShell';
import { SectionCard } from '@/components/ui/SectionCard';
import { supabaseAdmin } from '@/lib/db';

async function fetchCampaigns() {
  const { data } = await supabaseAdmin
    .from('campaigns')
    .select('*')
    .order('created_at', { ascending: false });
  return data ?? [];
}

const statusStyle = (status: string): React.CSSProperties => ({
  background: status === 'enviando' ? '#C8FF00' : status === 'completada' ? '#E8FFB0' : '#F0F0F0',
  color: status === 'borrador' ? '#888' : '#000',
  borderRadius: '999px',
  padding: '4px 14px',
  fontSize: '11px',
  fontWeight: 700,
  textTransform: 'uppercase' as const,
  letterSpacing: '0.06em',
});

export default async function CampaignsPage() {
  const campaigns = await fetchCampaigns();

  return (
    <AdminShell>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
        <SectionCard title="Campañas" description="Mensajes personalizados para grupos segmentados.">
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {campaigns.length === 0 && (
              <p style={{ color: '#999', fontSize: '14px', textAlign: 'center', padding: '24px 0' }}>No hay campañas creadas.</p>
            )}
            {campaigns.map((campaign: any) => (
              <div
                key={campaign.id}
                style={{
                  background: '#F5F5F5',
                  borderRadius: '14px',
                  padding: '16px 20px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
                  <div>
                    <p style={{ fontSize: '15px', fontWeight: 700, color: '#000', margin: 0 }}>{campaign.name}</p>
                    <p style={{ fontSize: '12px', color: '#999', margin: '2px 0 0 0' }}>
                      Filtro: {campaign.target_filter || 'todos'} · Enviados: {campaign.sent_count}
                    </p>
                  </div>
                  <span style={statusStyle(campaign.status)}>{campaign.status}</span>
                </div>
                <p style={{ fontSize: '13px', color: '#666', marginTop: '10px', lineHeight: 1.6 }}>{campaign.message}</p>
              </div>
            ))}
          </div>
        </SectionCard>
      </div>
    </AdminShell>
  );
}
