'use client';

import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';

export type Agent = {
  id: string;
  name: string;
  role: 'admin' | 'agent' | 'operator';
  // Permisos opcionales del operator (admin/agent siempre tienen acceso).
  can_see_top_clients?: boolean;
  can_see_campaigns?:   boolean;
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

export function AuthProvider({ children }: { children: ReactNode }) {
  const [agent,   setAgent]   = useState<Agent | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/me');
      setAgent(res.ok ? await res.json() : null);
    } catch {
      setAgent(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    // El borrado real de la cookie es server-side (es httpOnly, JS no la puede
    // tocar). Esperamos a que el POST limpie la cookie antes de redirigir.
    try { await fetch('/api/auth/logout', { method: 'POST', cache: 'no-store' }); } catch {}
    setAgent(null);
    // replace() evita que el back/bfcache (mobile Safari) restaure la vista autenticada.
    window.location.replace('/login');
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return <Ctx.Provider value={{ agent, loading, refresh, logout }}>{children}</Ctx.Provider>;
}
