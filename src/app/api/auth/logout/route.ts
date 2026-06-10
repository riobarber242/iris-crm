import { NextResponse } from 'next/server';
import { COOKIE_NAME } from '@/lib/session';

export async function POST() {
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
