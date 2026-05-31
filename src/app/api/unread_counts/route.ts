import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';

export async function GET() {
  try {
    const { data, error } = await supabaseAdmin
      .from('messages')
      .select('contact_id')
      .eq('role', 'assistant')
      .neq('status', 'read');

    if (error) return new NextResponse(error.message, { status: 500 });

    const counts: Record<string, number> = {};
    (data ?? []).forEach((row: any) => {
      const id = row.contact_id as string;
      counts[id] = (counts[id] ?? 0) + 1;
    });

    return NextResponse.json(counts);
  } catch (err: any) {
    return new NextResponse(String(err.message ?? err), { status: 500 });
  }
}
