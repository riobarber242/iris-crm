import type { ReactNode } from 'react';
import { AdminShell } from '@/components/AdminShell';

// Layout compartido de todo el panel autenticado. AdminShell (header + sidebar)
// vive acá UNA sola vez: al navegar entre secciones el shell ya no se desmonta
// ni se vuelve a montar, así que no re-dispara sus fetches/suscripciones y la
// navegación se siente instantánea. Solo cambia el contenido (`children`).
// Login y la home quedan FUERA de este grupo a propósito (sin shell).
export default function PanelLayout({ children }: { children: ReactNode }) {
  return <AdminShell>{children}</AdminShell>;
}
