'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, useEffect, useRef } from 'react';
import { createClient } from '@supabase/supabase-js';
import type { ReactNode } from 'react';

const navItems = ['dashboard', 'conversations', 'contacts', 'comprobantes', 'leads', 'campanas', 'settings'];

const navLabels: Record<string, string> = {
  dashboard:     'Dashboard',
  conversations: 'Conversaciones',
  contacts:      'Contactos',
  comprobantes:  'Comprobantes',
  leads:         'Top Clientes',
  campanas:      'Campañas',
  settings:      'Configuración',
};

const BANNER_H = 80;

export function AdminShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [botEnabled, setBotEnabled] = useState(true);
  const [mounted, setMounted]       = useState(false);
  const [unread, setUnread] = useState({ total: 0, newPending: 0, recurringPending: 0 });
  const unreadChannelRef            = useRef<any>(null);
  const unreadSupabaseRef           = useRef<any>(null);

  useEffect(() => {
    fetch('/api/settings/bot-enabled')
      .then((r) => r.json())
      .then((d) => { setBotEnabled(d.enabled); setMounted(true); })
      .catch(() => setMounted(true));
  }, []);

  const fetchUnreadRef = useRef<() => void>(() => {});

  useEffect(() => {
    async function fetchUnread() {
      try {
        const res = await fetch('/api/unread_counts');
        if (!res.ok) return;
        const data = await res.json();
        setUnread({
          total:            data.total            ?? 0,
          newPending:       data.newPending        ?? 0,
          recurringPending: data.recurringPending  ?? 0,
        });
      } catch {}
    }
    fetchUnreadRef.current = fetchUnread;

    fetchUnread();
    const timer = setInterval(fetchUnread, 15_000);

    // Immediate refresh when ConversationsClient marks a conversation as read
    function handleRefreshEvent() { fetchUnread(); }
    window.addEventListener('refresh-unread', handleRefreshEvent);

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (url && key) {
      const sb = createClient(url, key);
      unreadSupabaseRef.current = sb;
      const ch = sb.channel('unread-badge')
        .on('postgres_changes' as any, { event: 'INSERT', schema: 'public', table: 'messages' }, fetchUnread)
        .subscribe();
      unreadChannelRef.current = ch;
    }

    return () => {
      clearInterval(timer);
      window.removeEventListener('refresh-unread', handleRefreshEvent);
      try { if (unreadChannelRef.current) unreadSupabaseRef.current?.removeChannel(unreadChannelRef.current); } catch {}
    };
  }, []);

  // Refresh unread badge immediately on every route change
  // (when operator opens/closes a conversation, last_read_at updates → count drops)
  useEffect(() => {
    fetchUnreadRef.current();
  }, [pathname]);

  async function toggleBot() {
    const next = !botEnabled;
    setBotEnabled(next);
    try {
      const res = await fetch('/api/settings/bot-enabled', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
      const json = await res.json();
      console.log('[toggleBot] API response:', json);
      if (!res.ok || !json.ok) {
        console.error('[toggleBot] Falló el guardado, revirtiendo estado');
        setBotEnabled(!next);
      }
    } catch (err) {
      console.error('[toggleBot] Error de red:', err);
      setBotEnabled(!next);
    }
  }

  return (
    <div style={{ minHeight: '100vh', background: '#F5F5F5', display: 'flex', flexDirection: 'column' }}>

      {/* ── BANNER FULL-WIDTH ── */}
      <header style={{
        position: 'sticky',
        top: 0,
        zIndex: 50,
        width: '100%',
        height: `${BANNER_H}px`,
        background: 'linear-gradient(90deg, #C8FF00 0%, #a8d800 100%)',
        boxShadow: '0 6px 0 #7aa000, 0 10px 15px rgba(0,0,0,0.3)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 32px',
        flexShrink: 0,
      }}>

        {/* Logo */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '12px' }}>
          <span style={{
            fontSize: '42px',
            fontWeight: 900,
            color: '#000',
            lineHeight: 1,
            letterSpacing: '-1px',
            textShadow: '0 2px 0 rgba(255,255,255,0.8), 0 4px 8px rgba(0,0,0,0.3)',
          }}>
            IRIS
          </span>
          <span style={{
            fontSize: '20px',
            fontWeight: 300,
            color: '#1a3300',
            letterSpacing: '10px',
            textTransform: 'uppercase',
            textShadow: '0 1px 0 rgba(255,255,255,0.6), 0 2px 4px rgba(0,0,0,0.2)',
          }}>
            CRM
          </span>
        </div>

        {/* Toggle Bot/Humano */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
          <span style={{
            fontSize: '20px',
            fontWeight: 900,
            color: '#000',
            letterSpacing: '2px',
            textTransform: 'uppercase',
            opacity: mounted ? 1 : 0,
            transition: 'opacity 0.2s',
            lineHeight: 1,
            textShadow: '0 2px 0 rgba(255,255,255,0.8), 0 4px 6px rgba(0,0,0,0.25)',
          }}>
            {botEnabled ? 'BOT' : 'HUMANO'}
          </span>
          <button
            onClick={toggleBot}
            className="toggle-3d"
            aria-label={botEnabled ? 'Desactivar bot' : 'Activar bot'}
            style={{
              position: 'relative',
              display: 'inline-flex',
              alignItems: 'center',
              width: '100px',
              height: '48px',
              borderRadius: '24px',
              border: 'none',
              cursor: 'pointer',
              padding: '4px',
              background: '#1a1a1a',
              outline: 'none',
            }}
          >
            <span style={{
              display: 'block',
              width: '40px',
              height: '40px',
              borderRadius: '50%',
              background: botEnabled ? '#C8FF00' : '#FFFFFF',
              transform: botEnabled ? 'translateX(52px)' : 'translateX(0)',
              transition: 'transform 0.2s, background 0.2s',
              flexShrink: 0,
            }} />
          </button>
        </div>
      </header>

      {/* ── BELOW BANNER: sidebar + content ── */}
      <div style={{ flex: 1, display: 'flex' }}>

        {/* ── SIDEBAR ── */}
        <aside style={{
          width: '220px',
          minWidth: '220px',
          background: '#FFFFFF',
          display: 'flex',
          flexDirection: 'column',
          padding: '20px 14px',
          boxShadow: '2px 0 12px rgba(0,0,0,0.06)',
          position: 'sticky',
          top: `${BANNER_H}px`,
          height: `calc(100vh - ${BANNER_H}px)`,
          overflowY: 'auto',
        }}>
          <nav style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {navItems.map((item) => {
              const path = item === 'dashboard' ? '/dashboard' : `/${item}`;
              const active = pathname === path;
              return (
                <Link
                  key={item}
                  href={path}
                  className={active ? 'nav-3d-active' : 'nav-3d'}
                  style={{
                    display: 'block',
                    borderRadius: '10px',
                    padding: '10px 14px',
                    fontSize: '14px',
                    fontWeight: active ? 700 : 500,
                    color: active ? '#000' : '#555',
                    background: active ? '#C8FF00' : 'transparent',
                    textDecoration: 'none',
                  }}
                >
                  <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    {navLabels[item]}
                    {item === 'conversations' && (unread.newPending > 0 || unread.recurringPending > 0) && (
                      <span style={{ display: 'flex', gap: '3px', alignItems: 'center' }}>
                        {unread.newPending > 0 && (
                          <span style={{
                            background: '#FF8C00', color: '#fff', borderRadius: '999px',
                            fontSize: '10px', fontWeight: 800, minWidth: '18px', height: '18px',
                            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                            padding: '0 5px', lineHeight: 1,
                          }}>
                            {unread.newPending > 99 ? '99+' : unread.newPending}
                          </span>
                        )}
                        {unread.recurringPending > 0 && (
                          <span style={{
                            background: '#E53935', color: '#fff', borderRadius: '999px',
                            fontSize: '10px', fontWeight: 800, minWidth: '18px', height: '18px',
                            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                            padding: '0 5px', lineHeight: 1,
                          }}>
                            {unread.recurringPending > 99 ? '99+' : unread.recurringPending}
                          </span>
                        )}
                      </span>
                    )}
                  </span>
                </Link>
              );
            })}
          </nav>
        </aside>

        {/* ── CONTENT ── */}
        <main style={{ flex: 1, padding: '24px', overflowX: 'hidden', minWidth: 0 }}>
          {children}
        </main>

      </div>
    </div>
  );
}
