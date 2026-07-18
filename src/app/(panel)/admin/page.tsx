import { redirect } from 'next/navigation';

// /admin no tiene panel propio: el panel de clientes vive en /admin/tenants.
// Sin esta página, la URL pelada /admin daba 404 (no había índice). Redirigimos
// para que la URL directa y los bookmarks caigan en el panel de clientes.
export default function AdminIndexPage() {
  redirect('/admin/tenants');
}
