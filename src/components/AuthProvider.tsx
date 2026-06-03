'use client';

import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';

export type Agent = { id: string; name: string; role: 'admin' | 'agent' };

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
    try { await fetch('/api/auth/logout', { method: 'POST' }); } catch {}
    setAgent(null);
    window.location.href = '/login';
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return <Ctx.Provider value={{ agent, loading, refresh, logout }}>{children}</Ctx.Provider>;
}
