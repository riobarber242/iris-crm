import { AdminShell } from '@/components/AdminShell';
import { SectionCard } from '@/components/ui/SectionCard';
import { StatCard } from '@/components/ui/StatCard';
import { supabaseAdmin } from '@/lib/db';

async function fetchDashboardStats() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() - 6);
  const monthStart = new Date(today);
  monthStart.setDate(today.getDate() - 29);

  const contactsToday = await supabaseAdmin
    .from('contacts')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', today.toISOString());

  const contactsWeek = await supabaseAdmin
    .from('contacts')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', weekStart.toISOString());

  const contactsMonth = await supabaseAdmin
    .from('contacts')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', monthStart.toISOString());

  const comprobantesPending = await supabaseAdmin
    .from('comprobantes')
    .select('id', { count: 'exact', head: true })
    .eq('estado', 'pendiente');

  const vipLeads = await supabaseAdmin
    .from('leads')
    .select('id', { count: 'exact', head: true })
    .eq('score', 'vip');

  const activeLeads = await supabaseAdmin
    .from('leads')
    .select('id', { count: 'exact', head: true })
    .eq('score', 'activo');

  const coldLeads = await supabaseAdmin
    .from('leads')
    .select('id', { count: 'exact', head: true })
    .eq('score', 'frio');

  const verifiedAmount = await supabaseAdmin
    .from('comprobantes')
    .select('monto', { count: 'exact' })
    .eq('estado', 'verificado');

  return {
    contactsToday: contactsToday.count ?? 0,
    contactsWeek: contactsWeek.count ?? 0,
    contactsMonth: contactsMonth.count ?? 0,
    comprobantesPending: comprobantesPending.count ?? 0,
    vipLeads: vipLeads.count ?? 0,
    activeLeads: activeLeads.count ?? 0,
    coldLeads: coldLeads.count ?? 0,
    verifiedAmount: verifiedAmount.data?.reduce((sum, item) => sum + Number(item.monto ?? 0), 0) ?? 0,
  };
}

export default async function DashboardPage() {
  const stats = await fetchDashboardStats();

  return (
    <AdminShell>
      <div className="space-y-8">
        <SectionCard title="Resumen rápido" description="Métricas clave de Iris en tiempo real.">
          <div className="grid gap-6 lg:grid-cols-4">
            <StatCard label="Contactos hoy" value={`${stats.contactsToday}`} accent="purple" />
            <StatCard label="Contactos semana" value={`${stats.contactsWeek}`} accent="gold" />
            <StatCard label="Contactos mes" value={`${stats.contactsMonth}`} accent="pink" />
            <StatCard label="Comprobantes pendientes" value={`${stats.comprobantesPending}`} accent="green" />
          </div>
        </SectionCard>

        <SectionCard title="Leads y recargas" description="Clase VIP, activos y total estimado verificado.">
          <div className="grid gap-6 lg:grid-cols-4">
            <StatCard label="VIP" value={`${stats.vipLeads}`} accent="gold" />
            <StatCard label="Activo" value={`${stats.activeLeads}`} accent="green" />
            <StatCard label="Frío" value={`${stats.coldLeads}`} accent="pink" />
            <StatCard label="Monto verificado" value={`$${stats.verifiedAmount.toFixed(0)}`} accent="purple" />
          </div>
        </SectionCard>
      </div>
    </AdminShell>
  );
}
