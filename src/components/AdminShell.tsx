import Link from 'next/link';
import type { ReactNode } from 'react';

export function AdminShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-iris-background text-white">
      <div className="grid min-h-screen grid-cols-1 gap-6 px-6 py-6 lg:grid-cols-[280px_1fr]">
        <aside className="rounded-[32px] border border-white/10 bg-iris-card p-6 shadow-iris">
          <div className="mb-10">
            <p className="text-sm uppercase tracking-[0.28em] text-iris-pink">Iris CRM</p>
            <h1 className="mt-4 text-3xl font-semibold">Panel</h1>
            <p className="mt-3 text-sm text-iris-text-muted">Todo en un mismo lugar para gestionar la plataforma.</p>
          </div>
          <nav className="flex flex-col gap-3">
            {['dashboard', 'conversations', 'comprobantes', 'leads', 'campanas', 'settings'].map((item) => (
              <Link
                key={item}
                href={`/${item}`}
                className="rounded-3xl px-4 py-3 text-sm font-medium text-white transition hover:bg-white/5"
              >
                {item === 'campanas' ? 'Campañas' : item === 'settings' ? 'Configuración' : item === 'dashboard' ? 'Dashboard' : item.charAt(0).toUpperCase() + item.slice(1)}
              </Link>
            ))}
          </nav>
        </aside>
        <main>{children}</main>
      </div>
    </div>
  );
}
