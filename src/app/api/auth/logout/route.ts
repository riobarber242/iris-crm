import { NextResponse } from 'next/server';
import { COOKIE_NAME } from '@/lib/session';
import { getSessionAgent } from '@/lib/current-agent';
import { logActivity, ACTIVITY } from '@/lib/activity-log';

export async function POST(request: Request) {
  // Leemos la sesión ANTES de borrar la cookie, para atribuir el cierre.
  const session = await getSessionAgent();

  // El cliente manda el motivo: 'manual' (botón Salir) o 'inactividad'
  // (ActivityGuard). Por defecto 'manual'.
  let reason = 'manual';
  try {
    const body = await request.json();
    if (body?.reason) reason = String(body.reason);
  } catch { /* sin body → cierre manual */ }

  if (session) {
    await logActivity({
      session,
      action:     ACTIVITY.SESSION_LOGOUT,
      objectType: 'session',
      objectId:   session.sub,
      details:    { reason },
    });
  }

  const res = NextResponse.json({ ok: true });
  // Borrar la cookie con LOS MISMOS atributos con que se setea en el login
  // (secure + sameSite). Sin esto, navegadores móviles / PWA (como los que usan
  // los operadores) no eliminan la cookie Secure y la sesión sobrevive → "no
  // puedo cerrar sesión". Aplica a todos los roles por igual.
  res.cookies.set(COOKIE_NAME, '', {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path:     '/',
    maxAge:   0,
  });
  return res;
}
