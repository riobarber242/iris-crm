'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

const navItems = ['dashboard', 'conversations', 'comprobantes', 'leads', 'campanas', 'settings'];

export function AdminShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="min-h-screen bg-[#0A0A0A] text-white">
      <div className="grid min-h-screen grid-cols-1 gap-6 px-6 py-6 lg:grid-cols-[280px_1fr]">
        <aside className="rounded-[28px] border-2 border-[#C6FF00] bg-[#111111] p-6 shadow-iris">
          <div className="mb-10">
            <p className="text-sm uppercase tracking-[0.28em] text-[#C6FF00]">Iris CRM</p>
            <h1 className="mt-4 text-3xl font-bold text-white">Panel</h1>
            <p className="mt-3 text-sm text-[#888888]">Todo en un mismo lugar para gestionar la plataforma.</p>
          </div>
          <nav className="flex flex-col gap-3">
            {navItems.map((item) => {
              const path = item === 'dashboard' ? '/dashboard' : `/${item}`;
              const active = pathname === path;

              return (
                <Link
                  key={item}
                  href={path}
                  className={`rounded-[18px] border border-transparent px-4 py-3 text-sm font-semibold transition ${
                    active
                      ? 'bg-[#C6FF00]/10 text-[#C6FF00] shadow-[0_0_0_2px_rgba(198,255,0,0.15)]'
                      : 'text-white hover:bg-white/5'
                  }`}
                >
                  {item === 'campanas'
                    ? 'Campañas'
                    : item === 'settings'
                    ? 'Configuración'
                    : item === 'dashboard'
                    ? 'Dashboard'
                    : item.charAt(0).toUpperCase() + item.slice(1)}
                </Link>
              );
            })}
          </nav>
        </aside>
        <main>{children}</main>
      </div>
    </div>
  );
}
