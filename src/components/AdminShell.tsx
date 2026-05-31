'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, useEffect } from 'react';
import type { ReactNode } from 'react';

const navItems = ['dashboard', 'conversations', 'comprobantes', 'leads', 'campanas', 'settings'];

export function AdminShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [botEnabled, setBotEnabled] = useState(true);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    fetch('/api/settings/bot-enabled')
      .then((r) => r.json())
      .then((data) => {
        setBotEnabled(data.enabled);
        setMounted(true);
      })
      .catch(() => setMounted(true));
  }, []);

  async function toggleBot() {
    const next = !botEnabled;
    setBotEnabled(next);
    await fetch('/api/settings/bot-enabled', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: next }),
    });
  }

  return (
    <div className="min-h-screen text-white">
      {/* Header con toggle */}
      <header
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 50,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          padding: '12px 24px',
          borderBottom: '1px solid rgba(198,255,0,0.12)',
          backdropFilter: 'blur(12px)',
          backgroundColor: 'rgba(5,5,16,0.75)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span
            style={{
              fontSize: '12px',
              fontWeight: 600,
              letterSpacing: '0.08em',
              color: !mounted ? 'transparent' : botEnabled ? '#C6FF00' : '#888',
              transition: 'color 0.2s',
              minWidth: '56px',
              textAlign: 'right',
            }}
          >
            {botEnabled ? 'BOT' : 'HUMANO'}
          </span>
          <button
            onClick={toggleBot}
            aria-label={botEnabled ? 'Desactivar bot' : 'Activar bot'}
            style={{
              position: 'relative',
              display: 'inline-flex',
              alignItems: 'center',
              width: '52px',
              height: '28px',
              borderRadius: '14px',
              border: 'none',
              cursor: 'pointer',
              padding: '2px',
              backgroundColor: botEnabled ? '#C6FF00' : '#333',
              transition: 'background-color 0.2s',
              outline: 'none',
            }}
          >
            <span
              style={{
                display: 'block',
                width: '24px',
                height: '24px',
                borderRadius: '50%',
                backgroundColor: botEnabled ? '#050510' : '#888',
                transform: botEnabled ? 'translateX(24px)' : 'translateX(0)',
                transition: 'transform 0.2s, background-color 0.2s',
              }}
            />
          </button>
        </div>
      </header>

      {/* Layout principal */}
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
