import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { getSessionAgent } from '@/lib/current-agent';
import { sendMetaPurchaseEvent } from '@/lib/meta/conversions';
import { sendWhatsAppText } from '@/lib/meta/client';
import { reconcileContactStatus } from '@/lib/contact-status';
import { logActivity, ACTIVITY } from '@/lib/activity-log';
import { aplicarCargaComprobante, editarMovimientoComprobante } from '@/lib/caja';
import type { SessionPayload } from '@/lib/session';

// Bono en fichas (entero). Reglas Etapa 1: vacío → null; 0 o valor inválido →
// null ("0 no se guarda como bono"); entero > 0 → ese valor.
function normalizeBono(raw: any): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

// ¿Esta sesión puede editar este comprobante? admin/agent: cualquiera de su
// tenant; operator: solo el que él mismo resolvió (resolved_by === su id).
function canEditComprobante(session: SessionPayload, resolvedBy: string | null | undefined): boolean {
  if (session.role === 'admin' || session.role === 'agent') return true;
  return !!resolvedBy && resolvedBy === session.sub;
}

export async function GET(request: Request) {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });

  const url = new URL(request.url);
  const estado = url.searchParams.get('estado');

  let query = supabaseAdmin
    .from('comprobantes')
    .select('*, contacts(phone, name, casino_username)')
    .eq('tenant_id', session.tenant_id);
  if (estado && estado !== 'all') {
    query = query.eq('estado', estado);
  }

  const { data, error } = await query.order('created_at', { ascending: false });

  if (error) {
    return new NextResponse(error.message, { status: 500 });
  }

  // can_edit por item: el front decide mostrar el botón "Editar" sin conocer el
  // rol; el backend sigue siendo la fuente de verdad (revalida en la acción).
  const withPerms = (data ?? []).map((c: any) => ({
    ...c,
    can_edit: canEditComprobante(session, c.resolved_by),
  }));

  return NextResponse.json(withPerms);
}

export async function PATCH(request: Request) {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });

  const body = await request.json();
  const comprobanteId = body.comprobanteId;
  const action = body.action;

  if (!comprobanteId || !['verificar', 'rechazar', 'update_monto', 'editar'].includes(action)) {
    return new NextResponse('Faltan comprobanteId o acción válida', { status: 400 });
  }

  // editar: cambia monto y/o bono de un comprobante ya resuelto (botón "Editar").
  // No toca estado ni la atribución de verificación; sí registra quién editó.
  if (action === 'editar') {
    const monto = Number(body.monto);
    if (isNaN(monto) || monto <= 0) {
      return new NextResponse('Monto inválido', { status: 400 });
    }
    const bono = normalizeBono(body.bono);

    const { data: prev, error: prevErr } = await supabaseAdmin
      .from('comprobantes').select('*').eq('id', comprobanteId).eq('tenant_id', session.tenant_id).single();
    if (prevErr || !prev) {
      return new NextResponse('Comprobante no encontrado', { status: 404 });
    }

    // Permiso: admin/agent cualquiera; operator solo el que él resolvió.
    if (!canEditComprobante(session, prev.resolved_by)) {
      return new NextResponse('No tenés permiso para editar este comprobante', { status: 403 });
    }

    // Etapa 3: un comprobante tiene UN solo movimiento neto. Al editar,
    // revertimos el anterior y reaplicamos con los valores nuevos (no se crea
    // un segundo movimiento). Consistencia: si el reajuste falla (ej. sin
    // fichas), abortamos y NO persistimos la edición.
    const movEdit = await editarMovimientoComprobante(session, { comprobanteId, monto, bono });
    if (!movEdit.ok) return new NextResponse(movEdit.error, { status: 400 });

    const editPayload: Record<string, any> = {
      monto,
      bono,
      edited_by:      session.sub,
      edited_by_name: session.name,
      edited_at:      new Date().toISOString(),
    };

    let { data, error } = await supabaseAdmin
      .from('comprobantes').update(editPayload).eq('id', comprobanteId).eq('tenant_id', session.tenant_id).select('*').single();

    // Degradación elegante: si faltan columnas nuevas (bono/edited_*) porque la
    // migración supabase-bono-comprobante.sql no se corrió, reintentamos solo
    // con monto para no romper la edición.
    if (error && /bono|edited_by|edited_at|column|schema cache/i.test(error.message)) {
      ({ data, error } = await supabaseAdmin
        .from('comprobantes').update({ monto }).eq('id', comprobanteId).eq('tenant_id', session.tenant_id).select('*').single());
    }
    if (error) return new NextResponse(error.message, { status: 500 });

    await logActivity({
      session,
      action:     ACTIVITY.COMPROBANTE_EDITADO,
      objectType: 'comprobante',
      objectId:   comprobanteId,
      details: {
        antes:   { monto: prev.monto ?? null, bono: prev.bono ?? null },
        despues: { monto, bono },
        contact_id: prev.contact_id,
      },
    });

    return NextResponse.json(data);
  }

  // update_monto: only update monto, no estado change
  if (action === 'update_monto') {
    const monto = Number(body.monto);
    if (isNaN(monto) || monto <= 0) {
      return new NextResponse('Monto inválido', { status: 400 });
    }
    const { data, error } = await supabaseAdmin
      .from('comprobantes').update({ monto }).eq('id', comprobanteId).eq('tenant_id', session.tenant_id).select('*').single();
    if (error) return new NextResponse(error.message, { status: 500 });
    return NextResponse.json(data);
  }

  const estado = action === 'verificar' ? 'verificado' : 'rechazado';

  const { data: comprobante, error: fetchError } = await supabaseAdmin
    .from('comprobantes').select('*').eq('id', comprobanteId).eq('tenant_id', session.tenant_id).single();
  if (fetchError || !comprobante) {
    return new NextResponse('Comprobante no encontrado', { status: 404 });
  }

  // Accept optional monto from operator input
  const updatePayload: Record<string, any> = { estado };
  if (body.monto !== undefined) {
    const parsed = Number(body.monto);
    if (!isNaN(parsed) && parsed >= 0) updatePayload.monto = parsed;
  }
  // Bono (fichas) cargado a mano al verificar. Solo dato en Etapa 1.
  if (action === 'verificar' && body.bono !== undefined) {
    updatePayload.bono = normalizeBono(body.bono);
  }

  // Atribución permanente: quién resolvió (verificó/rechazó) este comprobante.
  updatePayload.resolved_by      = session.sub;
  updatePayload.resolved_by_name = session.name;
  updatePayload.resolved_at      = new Date().toISOString();

  // Monto/bono efectivos que quedarán guardados (input del operador o lo previo).
  const efectiveMonto = updatePayload.monto ?? comprobante.monto;
  const efectiveBono  = updatePayload.bono !== undefined ? updatePayload.bono : (comprobante.bono ?? null);

  // Etapa 3: si la caja está activa, descontar la carga del pozo y sumarla a la
  // billetera del operador ANTES de marcar verificado. Consistencia: si el
  // movimiento falla (ej. "No hay fichas suficientes"), NO se verifica.
  if (estado === 'verificado') {
    const movRes = await aplicarCargaComprobante(session, {
      comprobanteId,
      tipo:  comprobante.tipo,
      monto: Number(efectiveMonto ?? 0),
      bono:  efectiveBono,
    });
    if (!movRes.ok) return new NextResponse(movRes.error, { status: 400 });
  }

  let { data, error } = await supabaseAdmin
    .from('comprobantes').update(updatePayload).eq('id', comprobanteId).eq('tenant_id', session.tenant_id).select('*').single();

  // Degradación elegante: si las columnas resolved_* aún no existen (migración
  // supabase-activity-log.sql sin correr), reintentamos sin ellas para no romper
  // la verificación/rechazo. El log igual queda registrado abajo.
  if (error && /resolved_by|resolved_at|column|schema cache/i.test(error.message)) {
    const fallback: Record<string, any> = { estado };
    if (updatePayload.monto !== undefined) fallback.monto = updatePayload.monto;
    ({ data, error } = await supabaseAdmin
      .from('comprobantes').update(fallback).eq('id', comprobanteId).eq('tenant_id', session.tenant_id).select('*').single());
  }
  if (error) return new NextResponse(error.message, { status: 500 });

  // ── Reconciliar status del contacto con la regla de 3 estados ──
  // (nuevo / cliente_activo este mes / inactivo). Misma lógica que el cron.
  await reconcileContactStatus(comprobante.contact_id);

  // Registro de actividad (al costado; no traba la respuesta).
  await logActivity({
    session,
    action:     estado === 'verificado' ? ACTIVITY.COMPROBANTE_VERIFICADO : ACTIVITY.COMPROBANTE_RECHAZADO,
    objectType: 'comprobante',
    objectId:   comprobanteId,
    details:    { estado, monto: efectiveMonto ?? null, contact_id: comprobante.contact_id },
  });

  if (estado === 'verificado' && efectiveMonto) {
    const { data: contact, error: contactError } = await supabaseAdmin
      .from('contacts').select('phone, whatsapp_number_id').eq('id', comprobante.contact_id).eq('tenant_id', session.tenant_id).single();
    if (!contactError && contact?.phone) {
      // Fire-and-forget: Meta Pixel purchase event
      sendMetaPurchaseEvent(contact.phone, Number(efectiveMonto)).catch(() => {});

      // Check if auto-notification is enabled in settings (default: true)
      const { data: settingRow } = await supabaseAdmin
        .from('settings').select('value').eq('key', 'auto_verificacion_msg').eq('tenant_id', session.tenant_id).maybeSingle();
      const autoMsg = settingRow?.value !== 'false';

      if (autoMsg) {
        const montoFmt = Number(efectiveMonto).toLocaleString('es-AR');
        const msg = `Tu recarga de $${montoFmt} fue confirmada ✅ ¡Ya podés jugar!`;
        sendWhatsAppText(contact.phone, msg, session.tenant_id, contact.whatsapp_number_id).catch(() => {
          console.warn('[comprobantes] Auto-notificación WA falló (posible ventana 24h)');
        });
      }
    }
  }

  return NextResponse.json(data);
}
