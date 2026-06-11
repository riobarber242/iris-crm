'use client';

import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';

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
};

type AuthCtx = {
  agent:   Agent | null;
  loading: boolean;
  refresh: () => Promise<void>;
  logout:  () => Promise<void>;
};

const Ctx = createContext<AuthCtx>({
  agent: null, loading: true, refresh: async () => {}, logout: async () => {},
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

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/me');
      if (res.ok) {
        const a = (await res.json()) as Agent;
        setAgent(a);
        writeAgentHint(a);
      } else if (res.status === 401 || res.status === 403) {
        // Sesión realmente inválida → recién acá limpiamos el menú.
        setAgent(null);
        writeAgentHint(null);
      }
      // Otros estados (5xx transitorios) → conservamos el agente actual.
    } catch {
      // Error de red transitorio: NO blanqueamos el menú. Si todavía no hay
      // agente, caemos al último conocido en vez de dejar el sidebar vacío.
      setAgent((prev) => prev ?? readAgentHint());
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

  return <Ctx.Provider value={{ agent, loading, refresh, logout }}>{children}</Ctx.Provider>;
}
