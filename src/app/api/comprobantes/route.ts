import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { sendMetaPurchaseEvent } from '@/lib/meta/conversions';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const estado = url.searchParams.get('estado');

  let query = supabaseAdmin.from('comprobantes').select('*, contacts(phone, name, casino_username)');
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
      .from('comprobantes').update({ monto }).eq('id', comprobanteId).select('*').single();
    if (error) return new NextResponse(error.message, { status: 500 });
    return NextResponse.json(data);
  }

  const estado = action === 'verificar' ? 'verificado' : 'rechazado';

  const { data: comprobante, error: fetchError } = await supabaseAdmin
    .from('comprobantes').select('*').eq('id', comprobanteId).single();
  if (fetchError || !comprobante) {
    return new NextResponse('Comprobante no encontrado', { status: 404 });
  }

  // Accept optional monto from operator input
  const updatePayload: Record<string, any> = { estado };
  if (body.monto !== undefined) {
    const parsed = Number(body.monto);
    if (!isNaN(parsed) && parsed >= 0) updatePayload.monto = parsed;
  }

  const { data, error } = await supabaseAdmin
    .from('comprobantes').update(updatePayload).eq('id', comprobanteId).select('*').single();
  if (error) return new NextResponse(error.message, { status: 500 });

  const efectiveMonto = updatePayload.monto ?? comprobante.monto;
  if (estado === 'verificado' && efectiveMonto) {
    const { data: contact, error: contactError } = await supabaseAdmin
      .from('contacts').select('phone').eq('id', comprobante.contact_id).single();
    if (!contactError && contact?.phone) {
      await sendMetaPurchaseEvent(contact.phone, Number(efectiveMonto));
    }
  }

  return NextResponse.json(data);
}
