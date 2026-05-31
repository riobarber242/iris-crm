export const dynamic = 'force-dynamic';

import { AdminShell } from '@/components/AdminShell';
import DashboardClient from '@/components/DashboardClient';

export default async function DashboardPage() {
  return (
    <AdminShell>
      <div className="space-y-8">
        <DashboardClient />
      </div>
    </AdminShell>
  );
}
