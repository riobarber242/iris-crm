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

// Solo admin
const ADMIN_PREFIXES = ['/agentes', '/api/agents'];

function matchesPrefix(pathname: string, prefixes: string[]): boolean {
  return prefixes.some((p) => pathname === p || pathname.startsWith(p + '/'));
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

  // Rutas solo-admin
  if (matchesPrefix(pathname, ADMIN_PREFIXES) && session.role !== 'admin') {
    if (isApi) return NextResponse.json({ error: 'Requiere rol admin' }, { status: 403 });
    const url = req.nextUrl.clone();
    url.pathname = '/dashboard';
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

// Corre en todo menos archivos estáticos y assets de Next.
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)'],
};
