import { cookies } from 'next/headers';
import { verifySession, COOKIE_NAME, type SessionPayload } from './session';

// Reads + verifies the session cookie inside a Node route handler.
export async function getSessionAgent(): Promise<SessionPayload | null> {
  const token = (await cookies()).get(COOKIE_NAME)?.value;
  return verifySession(token);
}

// Convenience guard for admin-only routes (defense in depth on top of middleware).
export async function requireAdmin(): Promise<SessionPayload | null> {
  const session = await getSessionAgent();
  return session && session.role === 'admin' ? session : null;
}
