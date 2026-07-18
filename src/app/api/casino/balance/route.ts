import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { getSessionAgent } from '@/lib/current-agent';
import { getAgentBalance } from '@/lib/casino/client';
import { resolveCasinoCreds } from '@/lib/casino/account';

// Cache en memoria del saldo (por instancia/lambda) para no martillar el casino
// si varios agentes miran Fichas a la vez. Keyed por tenant: el saldo es el del
// agente de casino de ESE tenant (PR 2: ya no hay un único agente global). TTL
// corto (10s).
const CACHE_TTL_MS = 10_000;
const balanceCache = new Map<string, { balance: number; expiresAt: number }>();

// GET /api/casino/balance — saldo de fichas del agente en el casino.
//   { enabled: false }                      si el tenant no tiene casino activado
//   { enabled: true, balance, cached }      si está activado
//   { enabled: true, balance: null, error } si el casino no respondió
export async function GET() {
  // Cualquier usuario autenticado del tenant puede ver el saldo del casino
  // (los operadores también lo necesitan en su panel "Mi Caja").
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });

  // Gate por tenant: solo se muestra donde casino_deposit_enabled = 'true'.
  const { data: flagRow } = await supabaseAdmin
    .from('settings').select('value')
    .eq('key', 'casino_deposit_enabled').eq('tenant_id', session.tenant_id).maybeSingle();
  if (flagRow?.value !== 'true') {
    return NextResponse.json({ enabled: false });
  }

  const now = Date.now();
  const cached = balanceCache.get(session.tenant_id);
  if (cached && now < cached.expiresAt) {
    return NextResponse.json({ enabled: true, balance: cached.balance, cached: true });
  }

  // Credenciales del casino del tenant (fila de casino_accounts; fail-closed, sin fallback a env).
  const creds = await resolveCasinoCreds(session.tenant_id);
  if (!creds) {
    return NextResponse.json({ enabled: true, balance: null, error: 'Casino no configurado' });
  }

  const balance = await getAgentBalance(creds);
  if (balance === null) {
    // No pisamos el cache con un fallo; devolvemos lo último si lo hay.
    if (cached) {
      return NextResponse.json({ enabled: true, balance: cached.balance, cached: true, stale: true });
    }
    return NextResponse.json({ enabled: true, balance: null, error: 'No se pudo obtener el saldo del casino' });
  }

  balanceCache.set(session.tenant_id, { balance, expiresAt: now + CACHE_TTL_MS });
  return NextResponse.json({ enabled: true, balance, cached: false });
}
