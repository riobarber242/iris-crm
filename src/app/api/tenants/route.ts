import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { requireAdmin } from '@/lib/current-agent';

const TENANT_FIELDS =
  'id, name, whatsapp_phone_id, whatsapp_access_token, whatsapp_waba_id, whatsapp_display_number, created_at, ' +
  'plan, status, monthly_amount, trial_ends_at, paid_until, skin, notes';

// GET incluye el username del agente (rol='agent') y el system_prompt (settings)
// para que el listado muestre el usuario y el modal de edición traiga todo.
const TENANT_FIELDS_JOIN = `${TENANT_FIELDS}, agents(username, role), settings(key, value)`;

// Aplana los joins: username del agente + system_prompt, sin exponer el resto.
function mapTenant(row: any) {
  const { agents, settings, ...rest } = row;
  const username = (agents ?? []).find((a: any) => a.role === 'agent')?.username ?? null;
  const system_prompt = (settings ?? []).find((s: any) => s.key === 'system_prompt')?.value ?? '';
  return { ...rest, username, system_prompt };
}

// GET /api/tenants — lista de tenants (admin)
export async function GET() {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: 'Requiere rol admin' }, { status: 403 });
  }

  const { data, error } = await supabaseAdmin
    .from('tenants')
    .select(TENANT_FIELDS_JOIN)
    .order('created_at', { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json((data ?? []).map(mapTenant));
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
