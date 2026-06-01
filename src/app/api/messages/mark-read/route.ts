import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';

export async function POST(request: Request) {
  const body = await request.json();
  const contactId = body.contactId;

  if (!contactId) {
    return new NextResponse('Falta contactId', { status: 400 });
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('messages')
      .update({ status: 'read' })
      .eq('contact_id', contactId)
      .eq('role', 'assistant')
      .neq('status', 'read')
      .select('id');

    if (error) return new NextResponse(error.message, { status: 500 });

    return NextResponse.json({ updated: data?.length ?? 0 });
  } catch (err: any) {
    return new NextResponse(String(err.message ?? err), { status: 500 });
  }
}
