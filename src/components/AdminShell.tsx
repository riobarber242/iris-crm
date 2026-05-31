'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, useEffect } from 'react';
import type { ReactNode } from 'react';

const navItems = ['dashboard', 'conversations', 'comprobantes', 'leads', 'campanas', 'settings'];

const navLabels: Record<string, string> = {
  dashboard: 'Dashboard',
  conversations: 'Conversaciones',
  comprobantes: 'Comprobantes',
  leads: 'Leads',
  campanas: 'Campañas',
  settings: 'Configuración',
};

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
    <div style={{ minHeight: '100vh', background: '#F5F5F5', color: '#1a1a1a' }}>
      {/* Header */}
      <header
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 50,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 24px',
          background: '#FFFFFF',
          borderBottom: '1px solid #E8E8E8',
          boxShadow: '0 1px 8px rgba(0,0,0,0.06)',
        }}
      >
        <span style={{ fontSize: '13px', fontWeight: 700, letterSpacing: '0.12em', color: '#000', textTransform: 'uppercase' }}>
          Iris CRM
        </span>

        {/* Toggle Bot/Humano — pill oscuro estilo Lemon */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span
            style={{
              fontSize: '11px',
              fontWeight: 700,
              letterSpacing: '0.1em',
              color: !mounted ? 'transparent' : botEnabled ? '#C8FF00' : '#999',
              textTransform: 'uppercase',
              minWidth: '52px',
              textAlign: 'right',
              transition: 'color 0.2s',
            }}
          >
            {botEnabled ? 'Bot' : 'Humano'}
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
              padding: '3px',
              background: '#1a1a1a',
              transition: 'background 0.2s',
              outline: 'none',
            }}
          >
            <span
              style={{
                display: 'block',
                width: '22px',
                height: '22px',
                borderRadius: '50%',
                background: botEnabled ? '#C8FF00' : '#555',
                transform: botEnabled ? 'translateX(23px)' : 'translateX(0)',
                transition: 'transform 0.2s, background 0.2s',
              }}
            />
          </button>
        </div>
      </header>

      {/* Main layout */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr',
          gap: '24px',
          padding: '24px',
          minHeight: 'calc(100vh - 53px)',
        }}
        className="lg:grid-cols-[260px_1fr]"
      >
        {/* Sidebar */}
        <aside
          style={{
            background: '#FFFFFF',
            borderRadius: '20px',
            padding: '24px',
            boxShadow: '0 2px 16px rgba(0,0,0,0.07)',
            alignSelf: 'start',
            position: 'sticky',
            top: '77px',
          }}
        >
          <div style={{ marginBottom: '32px' }}>
            <div
              style={{
                display: 'inline-block',
                background: '#C8FF00',
                borderRadius: '10px',
                padding: '4px 12px',
                fontSize: '11px',
                fontWeight: 800,
                letterSpacing: '0.12em',
                color: '#000',
                textTransform: 'uppercase',
                marginBottom: '16px',
              }}
            >
              Iris CRM
            </div>
            <h1 style={{ fontSize: '22px', fontWeight: 800, color: '#000', margin: 0 }}>Panel</h1>
            <p style={{ fontSize: '13px', color: '#999', marginTop: '6px' }}>Gestioná tu plataforma</p>
          </div>

          <nav style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {navItems.map((item) => {
              const path = item === 'dashboard' ? '/dashboard' : `/${item}`;
              const active = pathname === path;
              return (
                <Link
                  key={item}
                  href={path}
                  style={{
                    display: 'block',
                    borderRadius: '12px',
                    padding: '10px 14px',
                    fontSize: '14px',
                    fontWeight: active ? 700 : 500,
                    color: active ? '#000' : '#666',
                    background: active ? '#C8FF00' : 'transparent',
                    transition: 'background 0.15s, color 0.15s',
                    textDecoration: 'none',
                  }}
                >
                  {navLabels[item]}
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
