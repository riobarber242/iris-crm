export const dynamic = 'force-dynamic';

import { AdminShell } from '@/components/AdminShell';
import { SectionCard } from '@/components/ui/SectionCard';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { supabaseAdmin } from '@/lib/db';

async function fetchComprobantes() {
  const { data } = await supabaseAdmin
    .from('comprobantes')
    .select('id, monto, estado, created_at, contacts(name, phone)')
    .order('created_at', { ascending: false });

  return data ?? [];
}

export default async function ComprobantesPage() {
  const comprobantes = await fetchComprobantes();

  return (
    <AdminShell>
      <div className="space-y-8">
        <SectionCard title="Comprobantes" description="Revisá y gestioná recibos pendientes desde el panel.">
          <div className="grid gap-4">
            {comprobantes.map((item: any) => (
              <div key={item.id} className="rounded-[28px] border border-white/10 bg-[#14141c] p-5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-base font-semibold text-white">{item.contacts?.name || item.contacts?.phone}</p>
                    <p className="text-sm text-iris-text-muted">Monto detectado: ${item.monto ?? '0'}</p>
                  </div>
                  <StatusBadge status={item.estado} />
                </div>
                <div className="mt-4 flex flex-col gap-3 rounded-3xl bg-iris-card p-4">
                  <p className="text-sm text-iris-text-muted">Fecha</p>
                  <p className="text-sm text-white">{new Date(item.created_at).toLocaleString('es-AR')}</p>
                  <div className="flex flex-wrap gap-3">
                    <button className="rounded-2xl bg-iris-green px-4 py-2 text-sm font-semibold text-black">Verificar ✓</button>
                    <button className="rounded-2xl bg-iris-pink px-4 py-2 text-sm font-semibold text-white">Rechazar ✗</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </SectionCard>
      </div>
    </AdminShell>
  );
}
