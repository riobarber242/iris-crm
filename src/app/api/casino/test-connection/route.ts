import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { requireAgentOrAdmin } from '@/lib/current-agent';
import { testCasinoConnection } from '@/lib/casino/client';
import { loadCasinoAccount, type CasinoCreds } from '@/lib/casino/account';

// POST /api/casino/test-connection — Etapa 2, PR 4.
// Prueba real de credenciales: Authenticate → GetAgentBalance, vía proxy. Modos:
//   { useSaved: true }  → prueba la fila default de casino_accounts del tenant.
//   { agentUsername, agentId, agentPassword, skinId, skinDomain | apiBaseUrl }
//                       → prueba credenciales tipeadas SIN guardarlas.
// Verde = nombre de agente + saldo real; rojo = mensaje específico por caso.
// Al pasar con la fila guardada, sella connection_verified_at = now().
//
// Guard: admin o agent (administran su propio tenant); operator → 403. SIEMPRE
// acotado al tenant de la sesión. NO exige casino_deposit_enabled: se prueba una
// conexión ANTES de habilitarla.

const MSG: Record<string, string> = {
  bad_credentials:  'Usuario o contraseña incorrectos',
  agent_not_found:  'Conectó pero no encontramos ese ID de agente',
  forbidden_target: 'Ese casino todavía no está habilitado, avisá a soporte',
  timeout:          'El casino no respondió, probá de nuevo',
  unknown:          'No se pudo conectar con el casino, probá de nuevo',
};

// Acepta host pelado ("admin.x.bond") o URL completa; deriva el host del casino.
function deriveHost(skinDomain?: unknown, apiBaseUrl?: unknown): string | null {
  const direct = String(skinDomain ?? '').trim();
  if (direct) {
    try { return new URL(direct).host; }
    catch { return direct.replace(/^https?:\/\//, '').replace(/\/.*$/, '') || null; }
  }
  const base = String(apiBaseUrl ?? '').trim();
  if (base) { try { return new URL(base).host; } catch { return null; } }
  return null;
}

export async function POST(request: Request) {
  const session = await requireAgentOrAdmin();
  if (!session) return new NextResponse('Requiere rol admin o agent', { status: 403 });

  const body = await request.json().catch(() => null);
  const tenantId = session.tenant_id;
  const useSaved = body?.useSaved === true;

  let creds: CasinoCreds | null = null;
  let hasSavedRow = false;

  if (useSaved) {
    creds = await loadCasinoAccount(tenantId);       // fila del tenant, sin fallback a env
    if (!creds) {
      return NextResponse.json({ ok: false, error: 'No hay una conexión de casino guardada para probar' }, { status: 404 });
    }
    hasSavedRow = true;
  } else {
    const agentUsername = String(body?.agentUsername ?? '').trim();
    const agentId       = String(body?.agentId ?? '').trim();
    const agentPassword = String(body?.agentPassword ?? '');
    const skinId        = String(body?.skinId ?? '').trim();
    const skinDomain    = deriveHost(body?.skinDomain, body?.apiBaseUrl);

    const missing = [
      !agentUsername && 'usuario', !agentId && 'ID de agente', !agentPassword && 'contraseña',
      !skinId && 'skin', !skinDomain && 'dominio del casino',
    ].filter(Boolean);
    if (missing.length) {
      return NextResponse.json({ ok: false, error: `Faltan datos: ${missing.join(', ')}` }, { status: 400 });
    }
    creds = { agentUsername, agentId, agentPassword, skinId, skinDomain: skinDomain!, tenantId };
  }

  const result = await testCasinoConnection(creds);

  if (!result.ok) {
    // 200 con ok:false: es un resultado de diagnóstico (verde/rojo), no un error del server.
    return NextResponse.json({ ok: false, reason: result.reason, error: MSG[result.reason] ?? MSG.unknown });
  }

  // Éxito. Si probamos la fila guardada, sellamos la verificación (PR 4, paso 4).
  let verifiedAt: string | null = null;
  if (hasSavedRow) {
    verifiedAt = new Date().toISOString();
    const { error } = await supabaseAdmin
      .from('casino_accounts')
      .update({ connection_verified_at: verifiedAt })
      .eq('tenant_id', tenantId).eq('is_default', true);   // índice único parcial ⇒ 1 fila
    if (error) {
      console.warn('[casino test-connection] no se pudo sellar connection_verified_at:', error.message);
      verifiedAt = null;   // el test pasó igual; solo no se persistió el sello
    }
  }

  return NextResponse.json({
    ok: true,
    agentName: result.agentName,
    balance: result.balance,
    verifiedAt,
    authResultKeys: result.authResultKeys,   // dato de diseño: ¿trae agentId/skinId?
  });
}
