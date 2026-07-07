import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { requireAdmin } from '@/lib/current-agent';

const FIELDS = 'id, name, icon, expires_at, notes, monthly_cost_usd, created_at';

// GET /api/admin/services — lista los servicios de la plataforma (solo admin).
export async function GET() {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: 'Requiere rol admin' }, { status: 403 });
  }

  const { data, error } = await supabaseAdmin
    .from('services')
    .select(FIELDS)
    .order('created_at', { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data ?? []);
}
