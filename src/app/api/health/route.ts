import { NextResponse } from 'next/server';

// Healthcheck para monitoreo externo (UptimeRobot, BetterStack, etc.).
// Público (ver PUBLIC_PREFIXES en middleware) y siempre dinámico.
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({
    ok: true,
    timestamp: new Date().toISOString(),
    version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? 'dev',
  });
}
