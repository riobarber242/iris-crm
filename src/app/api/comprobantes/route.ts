import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { sendMetaPurchaseEvent } from '@/lib/meta/conversions';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const estado = url.searchParams.get('estado');

  let query = supabaseAdmin.from('comprobantes').select('*, contacts(phone, name)');
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

  if (!comprobanteId || !['verificar', 'rechazar'].includes(action)) {
    return new NextResponse('Faltan comprobanteId o acción válida', { status: 400 });
  }

  const estado = action === 'verificar' ? 'verificado' : 'rechazado';
  const { data: comprobante, error: fetchError } = await supabaseAdmin
    .from('comprobantes')
    .select('*')
    .eq('id', comprobanteId)
    .single();

  if (fetchError || !comprobante) {
    return new NextResponse('Comprobante no encontrado', { status: 404 });
  }

  const { data, error } = await supabaseAdmin
    .from('comprobantes')
    .update({ estado })
    .eq('id', comprobanteId)
    .select('*')
    .single();

  if (error) {
    return new NextResponse(error.message, { status: 500 });
  }

  if (estado === 'verificado' && comprobante.monto) {
    const { data: contact, error: contactError } = await supabaseAdmin
      .from('contacts')
      .select('phone')
      .eq('id', comprobante.contact_id)
      .single();

    if (!contactError && contact?.phone) {
      await sendMetaPurchaseEvent(contact.phone, Number(comprobante.monto));
    }
  }

  return NextResponse.json(data);
}
