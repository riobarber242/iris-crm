'use client';

import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';

export type Agent = {
  id: string;
  name: string;
  role: 'admin' | 'agent' | 'operator';
  // Permisos opcionales del operator (admin/agent siempre tienen acceso).
  can_see_top_clients?: boolean;
  can_see_campaigns?:   boolean;
  // Perfil de usuario (foto + teléfono).
  avatar_url?: string | null;
  phone?:      string | null;
  // Cierre de sesión por inactividad (rol operator). Lo lee ActivityGuard.
  session_timeout_enabled?: boolean;
  session_timeout_minutes?: number;
};

// Resultado de refresh(): 'ok' = sesión cargada, 'denied' = 401/403 definitivo
// (no tiene sentido reintentar), 'error' = fallo transitorio (red caída, 5xx).
export type RefreshResult = 'ok' | 'denied' | 'error';

type AuthCtx = {
  agent:   Agent | null;
  loading: boolean;
  refresh: () => Promise<RefreshResult>;
  logout:  () => Promise<void>;
};

const Ctx = createContext<AuthCtx>({
  agent: null, loading: true, refresh: async () => 'error', logout: async () => {},
});

export function useAuth() {
  return useContext(Ctx);
}

// Recuerda el último agente confirmado (id/nombre/rol/flags — sin token, no es
// sensible) para hidratar el menú al instante y, sobre todo, para NO blanquear
// el sidebar ante un fallo transitorio de /api/auth/me (típico en mobile/PWA).
const AGENT_HINT_KEY = 'iris-auth-agent';
function readAgentHint(): Agent | null {
  try { const s = localStorage.getItem(AGENT_HINT_KEY); return s ? (JSON.parse(s) as Agent) : null; } catch { return null; }
}
function writeAgentHint(a: Agent | null): void {
  try { if (a) localStorage.setItem(AGENT_HINT_KEY, JSON.stringify(a)); else localStorage.removeItem(AGENT_HINT_KEY); } catch {}
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [agent,   setAgent]   = useState<Agent | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async (): Promise<RefreshResult> => {
    try {
      const res = await fetch('/api/auth/me', { cache: 'no-store' });
      if (res.ok) {
        const a = (await res.json()) as Agent;
        setAgent(a);
        writeAgentHint(a);
        return 'ok';
      }
      if (res.status === 401 || res.status === 403) {
        // Sesión realmente inválida → recién acá limpiamos el menú.
        setAgent(null);
        writeAgentHint(null);
        return 'denied';
      }
      // Otros estados (5xx transitorios) → conservamos el agente actual y
      // devolvemos 'error' para que el reintento automático insista.
      return 'error';
    } catch {
      // Error de red transitorio: NO blanqueamos el menú. Si todavía no hay
      // agente, caemos al último conocido en vez de dejar el sidebar vacío.
      setAgent((prev) => prev ?? readAgentHint());
      return 'error';
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    // El borrado real de la cookie es server-side (es httpOnly, JS no la puede
    // tocar). Esperamos a que el POST limpie la cookie antes de redirigir.
    try {
      await fetch('/api/auth/logout', {
        method: 'POST', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'manual' }),
      });
    } catch {}
    setAgent(null);
    writeAgentHint(null);
    // replace() evita que el back/bfcache (mobile Safari) restaure la vista autenticada.
    window.location.replace('/login');
  }, []);

  useEffect(() => {
    // Hidratación optimista: mostrar el menú del último rol conocido sin esperar
    // a /api/auth/me (evita el skeleton vacío persistente). Se lee en efecto
    // (cliente) para no romper la hidratación (el SSR arranca con agent=null).
    const hint = readAgentHint();
    if (hint) setAgent((prev) => prev ?? hint);
    refresh();
  }, [refresh]);

  // Este provider vive en el layout raíz y NO se re-monta al navegar. Tras el
  // login (router.push de /login al panel) nadie volvía a pedir /api/auth/me:
  // el agente quedaba null y la sidebar en esqueleto permanente hasta un F5.
  // Ante cada cambio de ruta sin agente cargado, re-consultamos la sesión.
  const pathname = usePathname();
  useEffect(() => {
    if (!agent) refresh();
    // setAgent(null) sobre null no re-renderiza (React bail-out) → sin loops.
  }, [pathname, agent, refresh]);

  // Reintento automático con backoff ante fallos TRANSITORIOS (red caída, 5xx):
  // sin esto, un único fetch fallido dejaba el panel en esqueleto para siempre.
  // 'denied' (401/403) corta enseguida: reintentar sin sesión no tiene sentido.
  useEffect(() => {
    if (agent) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const tick = async () => {
      if (disposed) return;
      const result = await refresh();
      if (disposed || result !== 'error') return;
      attempt++;
      if (attempt > 4) return; // se rinde — AdminShell ofrece "Reintentar" manual
      timer = setTimeout(tick, Math.min(8000, 1000 * 2 ** attempt));
    };

    // Espera corta inicial para no duplicar el fetch del mount/cambio de ruta.
    timer = setTimeout(tick, 1500);
    return () => { disposed = true; if (timer) clearTimeout(timer); };
  }, [agent, refresh]);

  return <Ctx.Provider value={{ agent, loading, refresh, logout }}>{children}</Ctx.Provider>;
}
