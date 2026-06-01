import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';

export async function GET() {
  const { data, error } = await supabaseAdmin
    .from('contacts')
    .select('id, phone, status, casino_username, created_at')
    .not('casino_username', 'is', null)
    .neq('casino_username', '')
    .order('created_at', { ascending: false });

  if (error) return new NextResponse(error.message, { status: 500 });
  return NextResponse.json(data ?? []);
}
