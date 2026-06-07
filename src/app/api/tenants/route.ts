import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { requireAdmin } from '@/lib/current-agent';

const TENANT_FIELDS = 'id, name, whatsapp_phone_id, whatsapp_access_token, created_at';

// GET /api/tenants — lista de tenants (admin)
export async function GET() {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: 'Requiere rol admin' }, { status: 403 });
  }

  const { data, error } = await supabaseAdmin
    .from('tenants')
    .select(TENANT_FIELDS)
    .order('created_at', { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data ?? []);
}

// POST /api/tenants — crear tenant (admin)
export async function POST(request: Request) {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: 'Requiere rol admin' }, { status: 403 });
  }

  let body: any;
  try { body = await request.json(); } catch { body = {}; }

  const name                  = String(body.name ?? '').trim();
  const whatsapp_phone_id     = String(body.whatsapp_phone_id ?? '').trim() || null;
  const whatsapp_access_token = String(body.whatsapp_access_token ?? '').trim() || null;

  if (!name) return NextResponse.json({ error: 'Falta el nombre del tenant' }, { status: 400 });

  const { data, error } = await supabaseAdmin
    .from('tenants')
    .insert({ name, whatsapp_phone_id, whatsapp_access_token })
    .select(TENANT_FIELDS)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json(data);
}
