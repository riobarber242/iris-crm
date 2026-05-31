'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, useEffect } from 'react';
import type { ReactNode } from 'react';

const navItems = ['dashboard', 'conversations', 'comprobantes', 'leads', 'campanas', 'settings'];

const navLabels: Record<string, string> = {
  dashboard:     'Dashboard',
  conversations: 'Conversaciones',
  comprobantes:  'Comprobantes',
  leads:         'Leads',
  campanas:      'Campañas',
  settings:      'Configuración',
};

export function AdminShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [botEnabled, setBotEnabled] = useState(true);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    fetch('/api/settings/bot-enabled')
      .then((r) => r.json())
      .then((d) => { setBotEnabled(d.enabled); setMounted(true); })
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
    /* Outer wrapper: full-height flex row */
    <div style={{ display: 'flex', minHeight: '100vh', background: '#F5F5F5' }}>

      {/* ── SIDEBAR ── */}
      <aside style={{
        width: '220px',
        minWidth: '220px',
        background: '#FFFFFF',
        display: 'flex',
        flexDirection: 'column',
        padding: '24px 16px',
        boxShadow: '2px 0 12px rgba(0,0,0,0.06)',
        position: 'sticky',
        top: 0,
        height: '100vh',
        overflowY: 'auto',
      }}>
        {/* Logo badge */}
        <div style={{ marginBottom: '32px' }}>
          <div style={{
            display: 'inline-block',
            background: '#C8FF00',
            borderRadius: '10px',
            padding: '5px 14px',
            fontSize: '12px',
            fontWeight: 800,
            letterSpacing: '0.14em',
            color: '#000',
            textTransform: 'uppercase',
            marginBottom: '18px',
          }}>
            Iris CRM
          </div>
          <p style={{ fontSize: '12px', color: '#bbb', margin: 0 }}>Panel de gestión</p>
        </div>

        {/* Nav */}
        <nav style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 1 }}>
          {navItems.map((item) => {
            const path = item === 'dashboard' ? '/dashboard' : `/${item}`;
            const active = pathname === path;
            return (
              <Link
                key={item}
                href={path}
                style={{
                  display: 'block',
                  borderRadius: '10px',
                  padding: '10px 14px',
                  fontSize: '14px',
                  fontWeight: active ? 700 : 500,
                  color: active ? '#000' : '#555',
                  background: active ? '#C8FF00' : 'transparent',
                  textDecoration: 'none',
                  transition: 'background 0.15s, color 0.15s',
                }}
              >
                {navLabels[item]}
              </Link>
            );
          })}
        </nav>
      </aside>

      {/* ── CONTENT AREA ── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>

        {/* Top bar */}
        <header style={{
          position: 'sticky',
          top: 0,
          zIndex: 40,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          padding: '12px 24px',
          background: '#FFFFFF',
          borderBottom: '1px solid #E8E8E8',
          boxShadow: '0 1px 6px rgba(0,0,0,0.05)',
        }}>
          {/* Toggle Bot/Humano */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{
              fontSize: '11px',
              fontWeight: 700,
              letterSpacing: '0.1em',
              color: !mounted ? 'transparent' : botEnabled ? '#C8FF00' : '#aaa',
              textTransform: 'uppercase',
              minWidth: '52px',
              textAlign: 'right',
              transition: 'color 0.2s',
            }}>
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
                outline: 'none',
              }}
            >
              <span style={{
                display: 'block',
                width: '22px',
                height: '22px',
                borderRadius: '50%',
                background: botEnabled ? '#C8FF00' : '#555',
                transform: botEnabled ? 'translateX(23px)' : 'translateX(0)',
                transition: 'transform 0.2s, background 0.2s',
              }} />
            </button>
          </div>
        </header>

        {/* Page content */}
        <main style={{ flex: 1, padding: '24px', overflowX: 'hidden' }}>
          {children}
        </main>
      </div>

    </div>
  );
}
