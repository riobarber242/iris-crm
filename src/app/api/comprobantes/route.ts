import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { getSessionAgent } from '@/lib/current-agent';
import { sendMetaPurchaseEvent } from '@/lib/meta/conversions';
import { sendWhatsAppText } from '@/lib/meta/client';
import { reconcileContactStatus } from '@/lib/contact-status';
import { logActivity, ACTIVITY } from '@/lib/activity-log';

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

  return NextResponse.json(data);
}

export async function PATCH(request: Request) {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });

  const body = await request.json();
  const comprobanteId = body.comprobanteId;
  const action = body.action;

  if (!comprobanteId || !['verificar', 'rechazar', 'update_monto'].includes(action)) {
    return new NextResponse('Faltan comprobanteId o acción válida', { status: 400 });
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

  // Atribución permanente: quién resolvió (verificó/rechazó) este comprobante.
  updatePayload.resolved_by      = session.sub;
  updatePayload.resolved_by_name = session.name;
  updatePayload.resolved_at      = new Date().toISOString();

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

  const efectiveMonto = updatePayload.monto ?? comprobante.monto;

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
