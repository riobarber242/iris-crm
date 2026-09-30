import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { requireAgentOrAdmin } from '@/lib/current-agent';
import { logActivity, ACTIVITY } from '@/lib/activity-log';
import { broadcastComprobanteChange } from '@/lib/realtime-broadcast';
import { featureBlocked } from '@/lib/plan-guard';
import { isStaleInFlight } from '@/lib/casino/deposit-guard';

// POST /api/comprobantes/casino-review — resolución MANUAL de un depósito al casino
// que quedó sin confirmar (casino_deposit_state = 'unknown', o 'in_flight' trabado).
// Ver lib/casino/deposit-guard: cuando no se puede saber si el casino acreditó, el
// comprobante se bloquea para no depositar dos veces y alguien lo mira en el panel del
// casino ("operaciones API").
//
// Body: { comprobanteId, outcome: 'entered' | 'not_entered' }
//   entered     → se marca acreditado (casino_deposited_at). La caja NO se mueve
//                 acá: se mueve al tocar Verificar (lib/casino/verify-carga), que
//                 saltea el depósito (ya hecho), registra la caja y verifica.
//   not_entered → se libera: al verificar se intenta el depósito de nuevo.
// No verifica el comprobante: eso sigue siendo el botón Verificar de siempre.
//
// Guard: admin o agent del tenant de la sesión (los operadores no: es una decisión
// sobre plata que exige mirar el panel del casino).
export async function POST(request: Request) {
  const blocked = await featureBlocked('caja');
  if (blocked) return blocked;

  const session = await requireAgentOrAdmin();
  if (!session) return new NextResponse('Solo un admin o agent puede resolver esto', { status: 403 });

  const body = await request.json().catch(() => ({} as any));
  const comprobanteId = typeof body.comprobanteId === 'string' ? body.comprobanteId : '';
  const outcome = body.outcome;
  if (!comprobanteId || (outcome !== 'entered' && outcome !== 'not_entered')) {
    return new NextResponse('Faltan comprobanteId u outcome válido', { status: 400 });
  }

  const { data: row, error: readErr } = await supabaseAdmin
    .from('comprobantes')
    .select('id, casino_deposited_at, casino_deposit_state, casino_deposit_started_at, casino_deposit_ref')
    .eq('id', comprobanteId).eq('tenant_id', session.tenant_id).maybeSingle();
  if (readErr) return new NextResponse(readErr.message, { status: 500 });
  if (!row) return new NextResponse('Comprobante no encontrado', { status: 404 });

  const pending = row.casino_deposit_state === 'unknown' || isStaleInFlight(row);
  if (row.casino_deposited_at || !pending) {
    return new NextResponse('Este comprobante no tiene un depósito pendiente de revisión', { status: 409 });
  }

  let ref: Record<string, unknown> = {};
  try { ref = row.casino_deposit_ref ? JSON.parse(row.casino_deposit_ref) : {}; } catch { ref = {}; }
  const review = { outcome, by: session.name, by_id: session.sub, at: new Date().toISOString() };

  const patch = outcome === 'entered'
    ? { casino_deposited_at: review.at, casino_deposit_state: 'done', casino_deposit_ref: JSON.stringify({ ...ref, review }) }
    : { casino_deposit_state: null, casino_deposit_started_at: null, casino_deposit_ref: JSON.stringify({ ...ref, review }) };

  // Condicional sobre el estado leído: si otra sesión lo resolvió en el medio, no se pisa.
  const { data: upd, error } = await supabaseAdmin
    .from('comprobantes').update(patch)
    .eq('id', comprobanteId).eq('tenant_id', session.tenant_id)
    .eq('casino_deposit_state', row.casino_deposit_state).is('casino_deposited_at', null)
    .select('id');
  if (error) return new NextResponse(error.message, { status: 500 });
  if (!upd?.length) return new NextResponse('Otra persona ya resolvió este comprobante. Actualizá la lista.', { status: 409 });

  await logActivity({
    session, action: ACTIVITY.CASINO_DEPOSIT, objectType: 'comprobante', objectId: comprobanteId,
    details: { manual_review: outcome, previous_state: row.casino_deposit_state, ref },
  });
  await broadcastComprobanteChange(session.tenant_id).catch(() => {});

  return NextResponse.json({ ok: true, outcome });
}
