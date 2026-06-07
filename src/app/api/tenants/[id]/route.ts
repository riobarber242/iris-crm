import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { requireAdmin } from '@/lib/current-agent';

const TENANT_FIELDS = 'id, name, whatsapp_phone_id, whatsapp_access_token, created_at';

// PATCH /api/tenants/[id] — editar tenant (admin)
// Campos editables: name, whatsapp_phone_id, whatsapp_access_token.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: 'Requiere rol admin' }, { status: 403 });
  }

  const { id } = await params;
  let body: any;
  try { body = await request.json(); } catch { body = {}; }

  const updates: Record<string, any> = {};
  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) return NextResponse.json({ error: 'El nombre no puede quedar vacío' }, { status: 400 });
    updates.name = name;
  }
  if (body.whatsapp_phone_id !== undefined)     updates.whatsapp_phone_id     = String(body.whatsapp_phone_id).trim() || null;
  if (body.whatsapp_access_token !== undefined) updates.whatsapp_access_token = String(body.whatsapp_access_token).trim() || null;

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'Nada para actualizar' }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from('tenants')
    .update(updates)
    .eq('id', id)
    .select(TENANT_FIELDS)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json(data);
}
