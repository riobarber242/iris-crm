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
  const vip = leads.filter((lead: any) => lead.score === 'vip').length;
  const activo = leads.filter((lead: any) => lead.score === 'activo').length;
  const frio = leads.filter((lead: any) => lead.score === 'frio').length;

  return (
    <AdminShell>
      <div className="space-y-8">
        <SectionCard title="Leads" description="Clasificación automática según recargas y actividad.">
          <div className="grid gap-6 lg:grid-cols-3">
            <StatCard label="VIP" value={`${vip}`} accent="gold" />
            <StatCard label="Activo" value={`${activo}`} accent="green" />
            <StatCard label="Frío" value={`${frio}`} accent="pink" />
          </div>
        </SectionCard>

        <SectionCard title="Detalle de leads" description="Revisá los contactos y la razón de su clasificación.">
          <div className="space-y-4">
            {leads.map((lead: any) => (
              <div key={lead.id} className="rounded-[28px] border border-white/10 bg-[#14141c] p-5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-base font-semibold text-white">{lead.contacts?.name || lead.contacts?.phone}</p>
                    <p className="text-sm text-iris-text-muted">{lead.reason ?? 'Sin motivo registrado'}</p>
                  </div>
                  <span className="rounded-full bg-white/5 px-3 py-1 text-sm text-iris-text-muted uppercase">{lead.score}</span>
                </div>
                <p className="mt-3 text-sm text-iris-text-muted">Calificado: {new Date(lead.qualified_at).toLocaleDateString('es-AR')}</p>
              </div>
            ))}
          </div>
        </SectionCard>
      </div>
    </AdminShell>
  );
}
