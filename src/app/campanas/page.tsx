import { AdminShell } from '@/components/AdminShell';
import CampanasClient from '@/components/CampanasClient';

export default function CampaignsPage() {
  return (
    <AdminShell>
      <CampanasClient />
    </AdminShell>
  );
}
