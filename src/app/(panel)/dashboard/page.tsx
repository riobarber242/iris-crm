export const dynamic = 'force-dynamic';

import DashboardClient from '@/components/DashboardClient';
import CajaResumen from '@/components/CajaResumen';

export default async function DashboardPage() {
  return (
    <div className="space-y-8">
      <CajaResumen />
      <DashboardClient />
    </div>
  );
}
