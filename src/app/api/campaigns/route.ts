import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';

export async function GET(request: Request) {
  const { data, error } = await supabaseAdmin
    .from('campaigns')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    return new NextResponse(error.message, { status: 500 });
  }

  return NextResponse.json(data);
}

export async function POST(request: Request) {
  const body = await request.json();
  const { name, message, target_filter } = body;

  if (!name || !message) {
    return new NextResponse('Faltan nombre o mensaje', { status: 400 });
  }

  const { data, error } = await supabaseAdmin.from('campaigns').insert({
    name,
    message,
    target_filter: target_filter ?? 'todos',
    status: 'borrador',
  }).select('*').single();

  if (error) {
    return new NextResponse(error.message, { status: 500 });
  }

  return NextResponse.json(data);
}

export async function PATCH(request: Request) {
  const body = await request.json();
  const campaignId = body.campaignId;
  const status = body.status;

  if (!campaignId || !['borrador', 'enviando', 'completada'].includes(status)) {
    return new NextResponse('Falta campaignId o estado válido', { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from('campaigns')
    .update({ status })
    .eq('id', campaignId)
    .select('*')
    .single();

  if (error) {
    return new NextResponse(error.message, { status: 500 });
  }

  return NextResponse.json(data);
}
