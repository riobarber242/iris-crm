import { cookies } from 'next/headers';
import { verifySession, COOKIE_NAME, type SessionPayload } from './session';

// Reads + verifies the session cookie inside a Node route handler.
export async function getSessionAgent(): Promise<SessionPayload | null> {
  const token = (await cookies()).get(COOKIE_NAME)?.value;
  const session = await verifySession(token);
  if (!session) return null;
  // Backward-compat: las sesiones firmadas antes del multi-tenant no traen
  // tenant_id → asumimos el tenant Principal hasta que vuelvan a loguearse.
  if (!session.tenant_id) session.tenant_id = '00000000-0000-0000-0000-000000000001';
  return session;
}

// Convenience guard for admin-only routes (defense in depth on top of middleware).
export async function requireAdmin(): Promise<SessionPayload | null> {
  const session = await getSessionAgent();
  return session && session.role === 'admin' ? session : null;
}

// Guard para gestión de operadores: lo usa admin (alcance global) y agent
// (acotado a SU tenant y solo sobre operadores — el filtrado se aplica en cada ruta).
export async function requireAgentOrAdmin(): Promise<SessionPayload | null> {
  const session = await getSessionAgent();
  return session && (session.role === 'admin' || session.role === 'agent') ? session : null;
}
