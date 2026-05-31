import { AdminShell } from '@/components/AdminShell';
import { SectionCard } from '@/components/ui/SectionCard';
export const dynamic = 'force-dynamic';

import { supabaseAdmin } from '@/lib/db';

async function fetchCampaigns() {
  const { data } = await supabaseAdmin
    .from('campaigns')
    .select('*')
    .order('created_at', { ascending: false });

  return data ?? [];
}

export default async function CampaignsPage() {
  const campaigns = await fetchCampaigns();

  return (
    <AdminShell>
      <div className="space-y-8">
        <SectionCard title="Campañas" description="Mensajes personalizados para enviar a grupos segmentados.">
          <div className="grid gap-4">
            {campaigns.map((campaign: any) => (
              <div key={campaign.id} className="rounded-[28px] border border-white/10 bg-[#14141c] p-5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-base font-semibold text-white">{campaign.name}</p>
                    <p className="text-sm text-iris-text-muted">Filtro: {campaign.target_filter || 'todos'}</p>
                  </div>
                  <span className="rounded-full bg-white/5 px-3 py-1 text-sm text-iris-text-muted uppercase">{campaign.status}</span>
                </div>
                <p className="mt-4 text-sm leading-7 text-iris-text-muted">{campaign.message}</p>
                <p className="mt-4 text-xs text-iris-text-muted">Enviados: {campaign.sent_count}</p>
              </div>
            ))}
          </div>
        </SectionCard>
      </div>
    </AdminShell>
  );
}
