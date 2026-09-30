import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { getSessionAgent } from '@/lib/current-agent';
import { getAgentBalance } from '@/lib/casino/client';
import { resolveCasinoCreds } from '@/lib/casino/account';
import { featureBlocked } from '@/lib/plan-guard';
import { loadNonLegacyAccount } from '@/lib/casino/provider-account';
import { stockModeFrom } from '@/lib/casino/stock-mode';

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
//   { enabled: false, casino_on: true, stock_mode: 'hybrid' }
//                                           casino activado pero el stock lo lleva
//                                           la caja manual (proveedor sin saldo del agente)
export async function GET() {
  const blocked = await featureBlocked('casino');
  if (blocked) return blocked;

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

  // Proveedores del modelo nuevo. `enabled` es lo que los paneles leen como "el
  // stock lo lleva el casino" (muestran el saldo y duermen el pozo). En modo
  // 'hybrid' (lib/casino/stock-mode: el proveedor no da el saldo del agente) va en
  // false, así Fichas / Mi Caja / Dashboard muestran la caja manual completa;
  // `casino_on` y `stock_mode` dicen que el casino igual está activado.
  const alt = await loadNonLegacyAccount(session.tenant_id);
  if (alt) {
    const mode = stockModeFrom(true, alt.kind === 'ok' ? alt.provider.id : alt.providerId);
    if (mode === 'hybrid') {
      return NextResponse.json({ enabled: false, casino_on: true, stock_mode: 'hybrid' });
    }
    if (alt.kind !== 'ok' || !alt.provider.agentBalance) {
      return NextResponse.json({ enabled: true, balance: null, error: 'No se pudo obtener el saldo del casino' });
    }
    const hit = balanceCache.get(session.tenant_id);
    if (hit && Date.now() < hit.expiresAt) {
      return NextResponse.json({ enabled: true, balance: hit.balance, cached: true });
    }
    const b = await alt.provider.agentBalance(alt.ctx);
    if (b === null) {
      return NextResponse.json({ enabled: true, balance: hit?.balance ?? null, cached: !!hit, stale: !!hit, error: hit ? undefined : 'No se pudo obtener el saldo del casino' });
    }
    balanceCache.set(session.tenant_id, { balance: b, expiresAt: Date.now() + CACHE_TTL_MS });
    return NextResponse.json({ enabled: true, balance: b, cached: false });
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
