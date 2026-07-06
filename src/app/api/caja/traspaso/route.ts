import { NextResponse } from 'next/server';
import { getSessionAgent } from '@/lib/current-agent';
import { verificarTraspaso, rechazarTraspaso } from '@/lib/caja';
import { broadcastMovimientoChange } from '@/lib/realtime-broadcast';

// ─────────────────────────────────────────────────────────────────────────────
// Verificación / rechazo de un CIERRE DE TURNO (traspaso) por el RECEPTOR.
//
// A diferencia de /api/caja/operador (operator-only), este endpoint acepta
// agent Y operator: el destino de un cierre puede ser el agente (deposita al
// agente) u otro operador. La autorización fina vive en verificarTraspaso /
// rechazarTraspaso (staff, o el operador que es el destino EXACTO del
// comprobante; nunca el origen). El admin de plataforma no entra al chat, pero
// si llegara, isStaff lo cubre igual.
//
//   ?accion=verificar → acredita la plata al destino (fn_acreditar_traspaso).
//   ?accion=rechazar  → marca el comprobante 'rechazado' (no acredita; no
//                       revierte el cierre del que cerró).
// ─────────────────────────────────────────────────────────────────────────────
export async function POST(request: Request) {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });
  if (session.role !== 'agent' && session.role !== 'operator' && session.role !== 'admin') {
    return new NextResponse('No autorizado', { status: 403 });
  }

  const accion = new URL(request.url).searchParams.get('accion');
  const body = await request.json().catch(() => ({} as any));
  const comprobanteId = String(body.comprobanteId ?? '');

  if (accion === 'verificar') {
    const r = await verificarTraspaso(session, comprobanteId);
    if (!r.ok) return new NextResponse(r.error, { status: r.degraded ? 409 : 400 });
    await broadcastMovimientoChange(session.tenant_id).catch(() => {}); // Fase 2
    return NextResponse.json({ ok: true, resumen: r.resumen });
  }

  if (accion === 'rechazar') {
    const r = await rechazarTraspaso(session, comprobanteId);
    if (!r.ok) return new NextResponse(r.error, { status: r.degraded ? 409 : 400 });
    await broadcastMovimientoChange(session.tenant_id).catch(() => {}); // Fase 2
    return NextResponse.json({ ok: true });
  }

  return new NextResponse('Acción inválida', { status: 400 });
}
