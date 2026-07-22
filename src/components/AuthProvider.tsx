'use client';

import { createContext, useContext, useEffect, useState, useCallback, useRef, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';

export type Agent = {
  id: string;
  name: string;
  role: 'admin' | 'agent' | 'operator';
  // tenant al que pertenece el usuario. Lo usa el Realtime Broadcast por tenant
  // (Fase 2) para armar el nombre del canal. Puede faltar en el hint de
  // localStorage recordado antes de esta versión: se rellena al resolver /me.
  tenant_id?: string | null;
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
  // id del último agente CONFIRMADO por el servidor (/api/auth/me). Sirve para
  // detectar que la sesión cambió por debajo: la cookie es una sola por navegador
  // y se comparte entre pestañas, así que loguear otra cuenta en otra pestaña la
  // pisa acá. NO se setea con el hint optimista de localStorage.
  const lastConfirmedIdRef = useRef<string | null>(null);
  // tenant del último agente confirmado. Se reconcilia JUNTO con el id: si un
  // mismo id puede quedar mapeado a otro tenant (p.ej. una cuenta global), un
  // cambio de tenant sin cambio de id también dispara la recarga dura.
  const lastConfirmedTenantRef = useRef<string | null>(null);

  const refresh = useCallback(async (): Promise<RefreshResult> => {
    try {
      const res = await fetch('/api/auth/me', { cache: 'no-store' });
      if (res.ok) {
        const a = (await res.json()) as Agent;
        // La sesión cambió por debajo (otra cuenta/tenant quedó en la cookie
        // compartida desde el último /me confirmado). Recarga dura → toda la UI y
        // los fetches se rehacen bajo la identidad real, sin estado cruzado. La
        // cookie es estable, así que tras recargar /me devuelve lo mismo y no hay
        // loop. Se compara id Y tenant: un cambio de cualquiera de los dos recarga.
        const prevId = lastConfirmedIdRef.current;
        if (prevId !== null && (prevId !== a.id || lastConfirmedTenantRef.current !== (a.tenant_id ?? null))) {
          window.location.reload();
          return 'ok';
        }
        lastConfirmedIdRef.current     = a.id;
        lastConfirmedTenantRef.current = a.tenant_id ?? null;
        setAgent(a);
        writeAgentHint(a);
        return 'ok';
      }
      if (res.status === 401 || res.status === 403) {
        // Sesión realmente inválida → recién acá limpiamos el menú.
        setAgent(null);
        writeAgentHint(null);
        lastConfirmedIdRef.current     = null;
        lastConfirmedTenantRef.current = null;
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
  // Re-consultamos la sesión en cada cambio de ruta (y también reconciliamos la
  // identidad contra la cookie, ver refresh()).
  const pathname = usePathname();
  useEffect(() => {
    // Reconciliar la sesión en cada navegación, incluso con agente ya cargado: si
    // la cookie cambió por debajo, refresh() lo detecta (cambio de id) y recarga.
    refresh();
  }, [pathname, refresh]);

  // Revalidar al volver a la pestaña / recuperar el foco: es el momento típico en
  // que la cookie compartida ya fue reemplazada por un login de otra cuenta en
  // otra pestaña. refresh() detecta el cambio de id y recarga a la identidad real.
  useEffect(() => {
    const onWake = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', onWake);
    return () => {
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', onWake);
    };
  }, [refresh]);

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
