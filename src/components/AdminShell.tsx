'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, useEffect, useRef } from 'react';
import { getSupabaseBrowser } from '@/lib/supabase-browser';
import { playPendingSound } from '@/lib/notify-sound';
import type { ReactNode } from 'react';
import { useAuth } from './AuthProvider';
import IrisAI from './IrisAI';

const navLabels: Record<string, string> = {
  dashboard:     'Dashboard',
  conversations: 'Conversaciones',
  contacts:      'Contactos',
  comprobantes:  'Comprobantes',
  leads:         'Top Clientes',
  campanas:      'Campañas',
  agentes:       'Operadores',
  tenants:       'Tenants',
  settings:      'Configuración',
};

const BANNER_H = 80;

export function AdminShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { agent, logout } = useAuth();
  // Menú por rol:
  //  - admin: todo + Operadores + Tenants.
  //  - agent: todo + Operadores, pero SIN Tenants (administración global).
  //  - operator: base reducida (conversaciones, contactos, comprobantes) y,
  //    opcionalmente, Top Clientes y Campañas según sus flags.
  let items: string[];
  if (agent?.role === 'admin') {
    items = ['dashboard', 'conversations', 'contacts', 'comprobantes', 'leads', 'campanas', 'agentes', 'tenants', 'settings'];
  } else if (agent?.role === 'operator') {
    items = ['conversations', 'contacts', 'comprobantes'];
    if (agent.can_see_top_clients) items.push('leads');
    if (agent.can_see_campaigns)   items.push('campanas');
  } else {
    // agent
    items = ['dashboard', 'conversations', 'contacts', 'comprobantes', 'leads', 'campanas', 'agentes', 'settings'];
  }
  const [botEnabled, setBotEnabled] = useState(true);
  const [offlineMode, setOfflineMode] = useState(false);
  const [mounted, setMounted]       = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [unread, setUnread] = useState({ total: 0, newPending: 0, recurringPending: 0, comprobantesPending: 0 });
  const unreadChannelRef            = useRef<any>(null);
  const unreadSupabaseRef           = useRef<any>(null);

  useEffect(() => {
    function fetchBotStatus() {
      fetch('/api/settings/bot-enabled')
        .then((r) => r.json())
        .then((d) => { setBotEnabled(d.enabled); setMounted(true); })
        .catch(() => setMounted(true));
      fetch('/api/settings/offline-mode')
        .then((r) => r.json())
        .then((d) => setOfflineMode(!!d.offline))
        .catch(() => {});
    }

    fetchBotStatus();
    // Poll every 30s so header stays in sync if toggled from Settings
    const timer = setInterval(fetchBotStatus, 30_000);

    // Instant sync when BotToggle in Settings fires the event
    function handleBotChange(e: Event) {
      const detail = (e as CustomEvent).detail;
      if (typeof detail?.enabled === 'boolean') setBotEnabled(detail.enabled);
    }
    window.addEventListener('bot-status-changed', handleBotChange);

    return () => {
      clearInterval(timer);
      window.removeEventListener('bot-status-changed', handleBotChange);
    };
  }, []);

  const fetchUnreadRef = useRef<() => void>(() => {});
  // Conteos previos para detectar SUBIDAS y disparar el sonido correspondiente.
  // -1 = todavía no cargó (no sonar en el primer fetch).
  const prevNewRef = useRef<number>(-1);
  const prevRecRef = useRef<number>(-1);

  useEffect(() => {
    async function fetchUnread() {
      try {
        const res = await fetch('/api/unread_counts');
        if (!res.ok) return;
        const data = await res.json();
        const newP = data.newPending       ?? 0; // 🟠
        const recP = data.recurringPending ?? 0; // 🔴

        // Sonido en tiempo real al aparecer un pendiente nuevo. Rojo tiene
        // prioridad. No suena en la primera carga (refs en -1).
        if (prevRecRef.current >= 0 && recP > prevRecRef.current) {
          playPendingSound('red');
        } else if (prevNewRef.current >= 0 && newP > prevNewRef.current) {
          playPendingSound('orange');
        }
        prevNewRef.current = newP;
        prevRecRef.current = recP;

        setUnread({
          total:               data.total               ?? 0,
          newPending:          newP,
          recurringPending:    recP,
          comprobantesPending: data.comprobantesPending  ?? 0,
        });
      } catch {}
    }
    fetchUnreadRef.current = fetchUnread;

    fetchUnread();
    const timer = setInterval(fetchUnread, 15_000);

    // Immediate refresh when ConversationsClient marks a conversation as read
    function handleRefreshEvent() { fetchUnread(); }
    window.addEventListener('refresh-unread', handleRefreshEvent);

    const sb = getSupabaseBrowser();
    if (sb) {
      unreadSupabaseRef.current = sb;
      const ch = sb.channel('unread-badge')
        .on('postgres_changes' as any, { event: 'INSERT', schema: 'public', table: 'messages' }, fetchUnread)
        .subscribe();
      unreadChannelRef.current = ch;
    }

    return () => {
      clearInterval(timer);
      window.removeEventListener('refresh-unread', handleRefreshEvent);
      try { if (unreadChannelRef.current) unreadSupabaseRef.current?.removeChannel(unreadChannelRef.current); } catch (err) { console.warn('[unread realtime] removeChannel falló:', err); }
    };
  }, []);

  // Refresh unread badge immediately on every route change
  // (when operator opens/closes a conversation, last_read_at updates → count drops)
  useEffect(() => {
    fetchUnreadRef.current();
    setMobileNavOpen(false); // cerrar el drawer al navegar
  }, [pathname]);

  async function toggleOffline() {
    const next = !offlineMode;
    setOfflineMode(next);
    try {
      const res = await fetch('/api/settings/offline-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offline: next }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) setOfflineMode(!next);
    } catch {
      setOfflineMode(!next);
    }
  }

  async function toggleBot() {
    const next = !botEnabled;
    setBotEnabled(next);
    window.dispatchEvent(new CustomEvent('bot-status-changed', { detail: { enabled: next } }));
    try {
      const res  = await fetch('/api/settings/bot-enabled', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setBotEnabled(!next);
        window.dispatchEvent(new CustomEvent('bot-status-changed', { detail: { enabled: !next } }));
      }
    } catch {
      setBotEnabled(!next);
      window.dispatchEvent(new CustomEvent('bot-status-changed', { detail: { enabled: !next } }));
    }
  }

  return (
    <div style={{ minHeight: '100vh', background: '#F5F5F5', display: 'flex', flexDirection: 'column' }}>

      {/* ── BANNER FULL-WIDTH ── */}
      <header className="app-header" style={{
        position: 'sticky',
        top: 0,
        zIndex: 50,
        width: '100%',
        height: `${BANNER_H}px`,
        background: '#0a0a0a',
        boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 32px',
        flexShrink: 0,
      }}>

        {/* Hamburguesa (mobile/tablet) + Logo */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <button
            className="app-hamburger"
            onClick={() => setMobileNavOpen((v) => !v)}
            aria-label="Abrir menú"
            style={{
              background: '#1a1a1a', border: 'none', borderRadius: '10px',
              width: '44px', height: '44px', cursor: 'pointer',
              alignItems: 'center', justifyContent: 'center', flexShrink: 0,
              flexDirection: 'column', gap: '4px',
            }}
          >
            <span style={{ width: '20px', height: '2px', background: '#aaff00', display: 'block' }} />
            <span style={{ width: '20px', height: '2px', background: '#aaff00', display: 'block' }} />
            <span style={{ width: '20px', height: '2px', background: '#aaff00', display: 'block' }} />
          </button>
          <span className="app-logo" style={{
            fontSize: '58px',
            fontWeight: 900,
            lineHeight: 1,
            letterSpacing: '-2px',
            color: '#aaff00',
          }}>
            IRIS
          </span>
        </div>

        {/* Toggle Bot/Humano */}
        <div className="app-header-right" style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>

          {/* Toggle OFFLINE — naranja/rojo cuando está activo */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '3px' }}>
            <button
              onClick={toggleOffline}
              className="toggle-3d"
              aria-label={offlineMode ? 'Desactivar modo offline' : 'Activar modo offline'}
              title={offlineMode ? 'Modo offline ACTIVO — el bot avisa que no operamos' : 'Activar modo offline'}
              style={{
                position: 'relative',
                display: 'inline-flex',
                alignItems: 'center',
                width: '52px',
                height: '28px',
                borderRadius: '17px',
                border: 'none',
                cursor: 'pointer',
                padding: '3px',
                background: offlineMode ? '#FF4444' : '#3a3a3a',
                outline: 'none',
                transition: 'background 0.2s',
              }}
            >
              <span style={{
                display: 'block',
                width: '22px',
                height: '22px',
                borderRadius: '50%',
                background: '#FFFFFF',
                transform: offlineMode ? 'translateX(24px)' : 'translateX(0)',
                transition: 'transform 0.2s',
                flexShrink: 0,
              }} />
            </button>
            <span style={{ fontSize: '9px', fontWeight: 700, color: '#ffffff', letterSpacing: '1px', textTransform: 'uppercase', lineHeight: 1, whiteSpace: 'nowrap', marginTop: '2px' }}>
              OFFLINE
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '3px' }}>
            <button
              onClick={toggleBot}
              className="toggle-3d"
              aria-label={botEnabled ? 'Desactivar bot' : 'Activar bot'}
              style={{
                position: 'relative',
                display: 'inline-flex',
                alignItems: 'center',
                width: '52px',
                height: '28px',
                borderRadius: '24px',
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
                background: botEnabled ? '#C8FF00' : '#FFFFFF',
                transform: botEnabled ? 'translateX(24px)' : 'translateX(0)',
                transition: 'transform 0.2s, background 0.2s',
                flexShrink: 0,
              }} />
            </button>
            <span style={{ fontSize: '9px', fontWeight: 700, color: '#ffffff', letterSpacing: '1px', textTransform: 'uppercase', lineHeight: 1, whiteSpace: 'nowrap', marginTop: '2px' }}>
              {botEnabled ? 'BOT' : 'HUM'}
            </span>
          </div>

          {/* Agente logueado + salir */}
          {agent && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', paddingLeft: '16px', marginLeft: '4px', borderLeft: '2px solid rgba(255,255,255,0.18)' }}>
              <span className="app-agent-name" style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.15 }}>
                <span style={{ fontSize: '14px', fontWeight: 800, color: '#fff' }}>{agent.name}</span>
                <span style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#aaff00' }}>
                  {agent.role === 'admin' ? 'Admin' : agent.role === 'operator' ? 'Operador' : 'Agente'}
                </span>
              </span>
              <button
                onClick={logout}
                style={{ background: '#1a1a1a', color: '#fff', fontWeight: 700, fontSize: '12px', border: 'none', borderRadius: '8px', padding: '8px 14px', cursor: 'pointer' }}
              >
                Salir
              </button>
            </div>
          )}
        </div>
      </header>

      {/* ── BELOW BANNER: sidebar + content ── */}
      <div style={{ flex: 1, display: 'flex' }}>

        {/* Overlay del drawer (solo mobile/tablet) */}
        <div
          className={`app-nav-overlay${mobileNavOpen ? ' open' : ''}`}
          onClick={() => setMobileNavOpen(false)}
        />

        {/* ── SIDEBAR ── */}
        <aside className={`app-sidebar${mobileNavOpen ? ' open' : ''}`} style={{
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
          zIndex: 100,
        }}>
          <nav style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {items.map((item) => {
              const path = item === 'dashboard' ? '/dashboard'
                         : item === 'tenants'   ? '/admin/tenants'
                         : `/${item}`;
              const active = pathname === path;
              return (
                <Link
                  key={item}
                  href={path}
                  onClick={() => setMobileNavOpen(false)}
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
                    {item === 'comprobantes' && unread.comprobantesPending > 0 && (
                      <span style={{
                        background: '#b8860b', color: '#fff', borderRadius: '999px',
                        fontSize: '10px', fontWeight: 800, minWidth: '18px', height: '18px',
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        padding: '0 5px', lineHeight: 1,
                      }}>
                        {unread.comprobantesPending > 99 ? '99+' : unread.comprobantesPending}
                      </span>
                    )}
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
        <main className="app-main" style={{ flex: 1, padding: '24px', overflowX: 'hidden', minWidth: 0 }}>
          {children}
        </main>

      </div>

      {/* Asistente Iris AI — botón flotante presente en toda la plataforma */}
      <IrisAI />
    </div>
  );
}
