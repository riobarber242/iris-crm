import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { getSessionAgent } from '@/lib/current-agent';
import { getAgentBalance } from '@/lib/casino/client';

// Cache en memoria del saldo (por instancia/lambda) para no martillar el casino
// si varios agentes miran Fichas a la vez. El saldo es GLOBAL (un único agente
// gonza0106), así que una sola entrada alcanza. TTL corto (10s).
const CACHE_TTL_MS = 10_000;
let balanceCache: { balance: number; expiresAt: number } | null = null;

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
  if (balanceCache && now < balanceCache.expiresAt) {
    return NextResponse.json({ enabled: true, balance: balanceCache.balance, cached: true });
  }

  const balance = await getAgentBalance();
  if (balance === null) {
    // No pisamos el cache con un fallo; devolvemos lo último si lo hay.
    if (balanceCache) {
      return NextResponse.json({ enabled: true, balance: balanceCache.balance, cached: true, stale: true });
    }
    return NextResponse.json({ enabled: true, balance: null, error: 'No se pudo obtener el saldo del casino' });
  }

  balanceCache = { balance, expiresAt: now + CACHE_TTL_MS };
  return NextResponse.json({ enabled: true, balance, cached: false });
}
