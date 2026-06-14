export const dynamic = 'force-dynamic';

import { AdminShell } from '@/components/AdminShell';
import DashboardClient from '@/components/DashboardClient';
import CajaResumen from '@/components/CajaResumen';

export default async function DashboardPage() {
  return (
    <AdminShell>
      <div className="space-y-8">
        <CajaResumen />
        <DashboardClient />
      </div>
    </AdminShell>
  );
}
