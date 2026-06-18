'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, useEffect, useRef } from 'react';
import { getSupabaseBrowser } from '@/lib/supabase-browser';
import { playPendingSound } from '@/lib/notify-sound';
import type { ReactNode } from 'react';
import { useAuth } from './AuthProvider';
import IrisChat from './IrisChat';
import ActivityGuard from './ActivityGuard';
import ProfileCard from './ProfileCard';

const navLabels: Record<string, string> = {
  dashboard:      'Dashboard',
  conversaciones: 'Conversaciones',
  contactos:      'Contactos',
  cargas:         'Cargas',
  pagos:          'Pagos',
  'mi-caja':      'Mi Caja',
  fichas:         'Fichas',
  'top-clientes': 'Top Clientes',
  campanas:       'Campañas',
  agentes:        'Operadores',
  tenants:        'Agentes',
  servicios:      'Servicios',
  'mi-bot':       'Mi Bot',
  'chat-interno': 'Chat interno',
  configuracion:  'Configuración',
};

const BANNER_H = 80;

export function AdminShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { agent, loading, refresh, logout } = useAuth();
  // El rol está confirmado en cuanto conocemos el agente (del backend o del
  // último rol recordado en AuthProvider). NO lo atamos a `loading`: así un
  // /api/auth/me lento o que falla una vez no deja al operador con el sidebar
  // vacío. El flash del menú equivocado igual se evita: con agent=null se
  // muestra el skeleton, nunca el menú completo.
  const roleReady = !!agent?.role;

  // Menú por rol:
  //  - admin: gestiona agentes-clientes (Agentes/Tenants), NO operadores.
  //  - agent: gestiona los operadores de su propio tenant (Operadores), no otros agentes.
  //  - operator: base reducida + Configuración (solo para cambiar su contraseña).
  let items: string[] = [];
  if (!roleReady) {
    items = []; // rol no confirmado → sidebar sin opciones (skeleton)
  } else if (agent?.role === 'admin') {
    items = ['dashboard', 'conversaciones', 'contactos', 'cargas', 'pagos', 'fichas', 'top-clientes', 'campanas', 'tenants', 'servicios', 'mi-bot', 'configuracion'];
  } else if (agent?.role === 'operator') {
    // Operador: Conversaciones, Contactos, Cargas, Pagos (verifica los suyos),
    // Mi Caja (panel de caja propio, solo lectura — Etapa 4b) y Configuración
    // (solo expone "Cambiar contraseña" para este rol).
    items = ['conversaciones', 'contactos', 'cargas', 'pagos', 'mi-caja', 'chat-interno', 'configuracion'];
  } else {
    // Agente: todo + Operadores (gestiona los de su tenant). Sin Tenants/Agentes.
    items = ['dashboard', 'conversaciones', 'contactos', 'cargas', 'pagos', 'fichas', 'top-clientes', 'campanas', 'agentes', 'chat-interno', 'mi-bot', 'configuracion'];
  }
  const [botEnabled, setBotEnabled] = useState(true);
  const [offlineMode, setOfflineMode] = useState(false);
  const [mounted, setMounted]       = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [unread, setUnread] = useState({ total: 0, newPending: 0, recurringPending: 0, comprobantesPending: 0, cargasPending: 0, pagosPending: 0 });
  const [internalUnread, setInternalUnread] = useState(0);
  const unreadChannelRef            = useRef<any>(null);
  const unreadSupabaseRef           = useRef<any>(null);
  const internalChannelRef          = useRef<any>(null);

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

    // Instant sync when OfflineConfig in Mi Bot toggles offline mode
    function handleOfflineChange(e: Event) {
      const detail = (e as CustomEvent).detail;
      if (typeof detail?.offline === 'boolean') setOfflineMode(detail.offline);
    }
    window.addEventListener('offline-mode-changed', handleOfflineChange);

    return () => {
      clearInterval(timer);
      window.removeEventListener('bot-status-changed', handleBotChange);
      window.removeEventListener('offline-mode-changed', handleOfflineChange);
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
          cargasPending:       data.cargasPending        ?? data.comprobantesPending ?? 0,
          pagosPending:        data.pagosPending         ?? 0,
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

  // Badge de no-leídos del CHAT INTERNO. Solo para miembros (agent/operator);
  // el admin de plataforma no participa, así que no consultamos para ese rol.
  // Refresca por polling, por el evento que dispara InternalChatClient al marcar
  // leído, y por realtime de internal_messages.
  const isInternalMember = agent?.role === 'agent' || agent?.role === 'operator';
  useEffect(() => {
    if (!isInternalMember) { setInternalUnread(0); return; }

    let disposed = false;
    async function fetchInternalUnread() {
      try {
        const res = await fetch('/api/internal/unread');
        if (!res.ok) return;
        const data = await res.json();
        if (!disposed) setInternalUnread(data.unread ?? 0);
      } catch {}
    }
    fetchInternalUnread();
    const timer = setInterval(fetchInternalUnread, 15_000);
    window.addEventListener('refresh-internal-unread', fetchInternalUnread);

    const sb = getSupabaseBrowser();
    if (sb) {
      const ch = sb.channel('internal-unread-badge')
        .on('postgres_changes' as any, { event: 'INSERT', schema: 'public', table: 'internal_messages' }, fetchInternalUnread)
        .subscribe();
      internalChannelRef.current = ch;
    }

    return () => {
      disposed = true;
      clearInterval(timer);
      window.removeEventListener('refresh-internal-unread', fetchInternalUnread);
      try { if (sb && internalChannelRef.current) sb.removeChannel(internalChannelRef.current); } catch (err) { console.warn('[internal unread realtime] removeChannel falló:', err); }
    };
  }, [isInternalMember]);

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

  const shell = (
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
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0, overflow: 'visible' }}>
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
          {/* Desktop: logo completo */}
          <svg className="logo-desktop" width="220" height="66" viewBox="0 0 680 200" xmlns="http://www.w3.org/2000/svg" style={{ flexShrink: 0 }}>
            <rect x="20" y="18" width="148" height="148" rx="26" fill="#111" stroke="#FF5500" strokeWidth="7"/>
            <circle cx="94" cy="88" r="44" fill="none" stroke="#D4E800" strokeWidth="5"/>
            <path d="M72 118 L52 142 L80 124" fill="#111" stroke="#D4E800" strokeWidth="5" strokeLinejoin="round" strokeLinecap="round"/>
            <path d="M114 48 L78 90 L102 90 L82 128 L124 76 L98 76 Z" fill="#D4E800"/>
            {/* "I" tipográfica en blanco, igual estilo que "RIS", alineada justo antes */}
            <text x="210" y="118" fontFamily="Arial Black, Impact, sans-serif" fontSize="108" fontWeight="900" fill="#FFFFFF" letterSpacing="-4">I</text>
            <text x="252" y="118" fontFamily="Arial Black, Impact, sans-serif" fontSize="108" fontWeight="900" fill="#FFFFFF" letterSpacing="-4">RIS</text>
            <text x="222" y="162" fontFamily="Arial, sans-serif" fontSize="26" fontWeight="800" fill="#00BBDD">—</text>
            <text x="258" y="162" fontFamily="Arial, sans-serif" fontSize="26" fontWeight="800" fill="#FF6600" letterSpacing="4">PREMIUM</text>
            <text x="430" y="162" fontFamily="Arial, sans-serif" fontSize="26" fontWeight="800" fill="#00BBDD">—</text>
          </svg>

          {/* Mobile: solo ícono */}
          <svg className="logo-mobile" width="52" height="52" viewBox="0 0 188 188" xmlns="http://www.w3.org/2000/svg" style={{ flexShrink: 0 }}>
            <rect x="4" y="4" width="180" height="180" rx="32" fill="#111" stroke="#FF5500" strokeWidth="8"/>
            <circle cx="94" cy="94" r="54" fill="none" stroke="#D4E800" strokeWidth="6"/>
            <path d="M72 124 L50 150 L78 130" fill="#111" stroke="#D4E800" strokeWidth="6" strokeLinejoin="round" strokeLinecap="round"/>
            <path d="M106 52 L76 96 L98 96 L84 138 L118 84 L94 84 Z" fill="#D4E800"/>
          </svg>
        </div>

        {/* Toggle Bot/Humano */}
        <div className="app-header-right" style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>

         {/* Toggles globales del bot. En celular se ocultan para dejar lugar al
             botón Salir (sobre todo en operadores, que usan el panel en mobile). */}
         <div className="app-header-toggles" style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>

          {/* Toggle OFFLINE — naranja/rojo cuando está activo */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '3px' }}>
            <button
              onClick={toggleOffline}
              className="toggle-3d hdr-toggle"
              aria-label={offlineMode ? 'Desactivar modo offline' : 'Activar modo offline'}
              title={offlineMode ? 'Modo offline ACTIVO — el bot avisa que no operamos' : 'Activar modo offline'}
              style={{ background: offlineMode ? '#FF4444' : '#3a3a3a' }}
            >
              <span
                className="hdr-toggle-knob"
                style={{
                  background: '#FFFFFF',
                  transform: offlineMode ? 'translateX(var(--knob-x))' : 'translateX(0)',
                }}
              />
            </button>
            <span style={{ fontSize: '9px', fontWeight: 700, color: '#ffffff', letterSpacing: '1px', textTransform: 'uppercase', lineHeight: 1, whiteSpace: 'nowrap', marginTop: '2px' }}>
              OFFLINE
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '3px' }}>
            <button
              onClick={toggleBot}
              className="toggle-3d hdr-toggle"
              aria-label={botEnabled ? 'Desactivar bot' : 'Activar bot'}
              style={{ background: '#1a1a1a' }}
            >
              <span
                className="hdr-toggle-knob"
                style={{
                  background: botEnabled ? '#C8FF00' : '#FFFFFF',
                  transform: botEnabled ? 'translateX(var(--knob-x))' : 'translateX(0)',
                }}
              />
            </button>
            <span style={{ fontSize: '9px', fontWeight: 700, color: '#ffffff', letterSpacing: '1px', textTransform: 'uppercase', lineHeight: 1, whiteSpace: 'nowrap', marginTop: '2px' }}>
              {botEnabled ? 'BOT' : 'HUM'}
            </span>
          </div>
         </div>

          {/* Agente logueado + salir. Solo cuando el rol está confirmado, para
              que nombre/rol/botón no flasheen con datos incorrectos en la carga. */}
          {roleReady && agent && (
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
            {!roleReady ? (
              loading ? (
                // Skeleton neutro: no revela ninguna opción hasta confirmar el rol.
                Array.from({ length: 5 }).map((_, i) => (
                  <div
                    key={i}
                    aria-hidden="true"
                    style={{
                      height: '40px',
                      borderRadius: '10px',
                      background: '#f0f0f0',
                      opacity: 0.7,
                    }}
                  />
                ))
              ) : (
                // La carga de sesión terminó sin agente (falló /api/auth/me y
                // se agotaron los reintentos automáticos): nunca dejamos el
                // esqueleto permanente — mensaje claro + reintento manual.
                <div style={{ padding: '14px 10px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  <p style={{ margin: 0, fontSize: '13px', color: '#888', lineHeight: 1.5 }}>
                    No se pudo cargar tu sesión.
                  </p>
                  <button
                    onClick={() => refresh()}
                    style={{
                      background: '#1a1a1a', color: '#C8FF00', fontWeight: 800, fontSize: '13px',
                      border: 'none', borderRadius: '10px', padding: '10px 14px', cursor: 'pointer',
                    }}
                  >
                    Reintentar
                  </button>
                </div>
              )
            ) : items.map((item) => {
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
                    {item === 'chat-interno' && internalUnread > 0 && (
                      <span style={{
                        background: '#FF8C00', color: '#fff', borderRadius: '999px',
                        fontSize: '10px', fontWeight: 800, minWidth: '18px', height: '18px',
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        padding: '0 5px', lineHeight: 1,
                      }}>
                        {internalUnread > 99 ? '99+' : internalUnread}
                      </span>
                    )}
                    {item === 'cargas' && unread.cargasPending > 0 && (
                      <span style={{
                        background: '#b8860b', color: '#fff', borderRadius: '999px',
                        fontSize: '10px', fontWeight: 800, minWidth: '18px', height: '18px',
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        padding: '0 5px', lineHeight: 1,
                      }}>
                        {unread.cargasPending > 99 ? '99+' : unread.cargasPending}
                      </span>
                    )}
                    {item === 'pagos' && unread.pagosPending > 0 && (
                      <span style={{
                        background: '#1a7a3a', color: '#fff', borderRadius: '999px',
                        fontSize: '10px', fontWeight: 800, minWidth: '18px', height: '18px',
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        padding: '0 5px', lineHeight: 1,
                      }}>
                        {unread.pagosPending > 99 ? '99+' : unread.pagosPending}
                      </span>
                    )}
                    {item === 'conversaciones' && (unread.newPending > 0 || unread.recurringPending > 0) && (
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

          {/* Perfil del usuario logueado (todos los roles), al pie del sidebar.
              En mobile el sidebar es el drawer hamburguesa → aparece ahí. */}
          {roleReady && <ProfileCard />}
        </aside>

        {/* ── CONTENT ── */}
        <main className="app-main" style={{ flex: 1, padding: '24px', overflowX: 'hidden', minWidth: 0 }}>
          {children}
        </main>

      </div>

      {/* Asistente Iris AI — chat flotante presente en toda la plataforma */}
      <IrisChat />
    </div>
  );

  // El control de inactividad sólo aplica a operadores (admin/agente quedan exentos).
  if (agent?.role === 'operator') {
    return <ActivityGuard>{shell}</ActivityGuard>;
  }
  return shell;
}
