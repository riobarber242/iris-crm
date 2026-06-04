import { AdminShell } from '@/components/AdminShell';
import CampanasClient from '@/components/CampanasClient';
import ReactivacionInactivos from '@/components/ReactivacionInactivos';

export default function CampaignsPage() {
  return (
    <AdminShell>
      <ReactivacionInactivos />
      <CampanasClient />
    </AdminShell>
  );
}
