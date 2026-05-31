import { AdminShell } from '@/components/AdminShell';
import { SectionCard } from '@/components/ui/SectionCard';
export const dynamic = 'force-dynamic';

import { supabaseAdmin } from '@/lib/db';

async function fetchSettings() {
  const { data } = await supabaseAdmin.from('settings').select('*');
  return data ?? [];
}

export default async function SettingsPage() {
  const settings = await fetchSettings();

  return (
    <AdminShell>
      <div className="space-y-8">
        <SectionCard title="Configuración" description="Ajustá el prompt de Iris y el canal de El Club de la Suerte.">
          <div className="grid gap-4">
            {settings.map((item: any) => (
              <div key={item.key} className="rounded-[28px] border border-white/10 bg-[#14141c] p-5">
                <p className="text-sm uppercase tracking-[0.2em] text-iris-pink">{item.key}</p>
                <p className="mt-3 text-base text-white">{item.value}</p>
              </div>
            ))}
          </div>
        </SectionCard>
      </div>
    </AdminShell>
  );
}
