import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { verifySession, COOKIE_NAME } from '@/lib/session';

// Paths reachable WITHOUT a session.
// ⚠️ CRÍTICO: /api/webhook (Meta) y /api/cron (Vercel) los llaman sistemas
// externos SIN cookie. Tienen que quedar públicos o el bot deja de funcionar.
const PUBLIC_PREFIXES = [
  '/login',
  '/api/auth',            // login/logout/me manejan su propia auth
  '/api/webhook',         // webhook de WhatsApp (Meta) — externo, sin cookie
  '/api/cron',            // cron de Vercel — externo, sin cookie
  '/api/admin/seed-auth', // bootstrap del admin, gateado por su propio secret
  '/api/health',          // healthcheck para monitoreo externo — sin cookie
];

// Solo admin: administración de tenants y servicios (datos globales del sistema).
const ADMIN_ONLY_PREFIXES = ['/admin', '/api/tenants', '/servicios', '/api/admin/services', '/api/admin/onboarding'];

// Solo staff interno (admin + agent). El rol 'operator' NO entra acá:
//  - Dashboard y sus métricas.
//  - Gestión de operadores (/agentes + /api/agents).
//  - Configuración de la cuenta (/configuracion) y del bot (/mi-bot).
// Nota: /api/settings/bot-enabled y /api/settings/offline-mode quedan FUERA
// a propósito porque el header los lee para todos los roles; solo bloqueamos
// las páginas /configuracion y /mi-bot y los endpoints de edición del bot
// (/api/agent/config, /api/settings/offline-msg).
const STAFF_PREFIXES = [
  '/dashboard',
  '/api/dashboard_stats',
  '/api/dashboard_charts',
  '/api/dashboard_metric',
  '/agentes',
  '/api/agents',
  '/fichas',          // caja de fichas: admin + agent (el operator no entra)
  '/api/fichas',
  '/configuracion',
  '/mi-bot',
  '/api/settings/offline-msg',
  '/api/agent/config',
];

// Campañas: admin + agent siempre; operator solo con can_see_campaigns.
const CAMPAIGNS_PREFIXES = ['/campanas', '/api/campaigns'];

// Top Clientes: admin + agent siempre; operator solo con can_see_top_clients.
const LEADS_PREFIXES = ['/top-clientes'];

function matchesPrefix(pathname: string, prefixes: string[]): boolean {
  return prefixes.some((p) => pathname === p || pathname.startsWith(p + '/'));
}

// Página de aterrizaje por rol (los operators no tienen dashboard).
function homeFor(role: string): string {
  return role === 'operator' ? '/conversaciones' : '/dashboard';
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (matchesPrefix(pathname, PUBLIC_PREFIXES)) {
    return NextResponse.next();
  }

  const isApi   = pathname.startsWith('/api/');
  const session = await verifySession(req.cookies.get(COOKIE_NAME)?.value);

  // Sin sesión válida → 401 para API, redirect a /login para páginas
  if (!session) {
    if (isApi) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    return NextResponse.redirect(url);
  }

  const { role } = session;

  // Helper: deniega según sea API (403) o página (redirect al home del rol).
  function deny(message: string) {
    if (isApi) return NextResponse.json({ error: message }, { status: 403 });
    const url = req.nextUrl.clone();
    url.pathname = homeFor(role);
    return NextResponse.redirect(url);
  }

  // Solo admin (administración de tenants).
  if (matchesPrefix(pathname, ADMIN_ONLY_PREFIXES) && role !== 'admin') {
    return deny('Requiere rol admin');
  }

  // Staff interno (admin + agent): los operators no entran.
  if (matchesPrefix(pathname, STAFF_PREFIXES) && role === 'operator') {
    return deny('No autorizado');
  }

  // Campañas: operator solo si tiene el flag habilitado.
  if (matchesPrefix(pathname, CAMPAIGNS_PREFIXES) && role === 'operator' && !session.can_see_campaigns) {
    return deny('No autorizado');
  }

  // Top Clientes: operator solo si tiene el flag habilitado.
  if (matchesPrefix(pathname, LEADS_PREFIXES) && role === 'operator' && !session.can_see_top_clients) {
    return deny('No autorizado');
  }

  return NextResponse.next();
}

// Corre en todo menos archivos estáticos y assets de Next.
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)'],
};
