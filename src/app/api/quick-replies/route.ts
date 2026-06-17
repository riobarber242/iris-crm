import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { getSessionAgent } from '@/lib/current-agent';

// Respuestas rápidas, aisladas por tenant. Requiere sesión.
// Degradación elegante: si la columna tenant_id aún no existe (migración
// supabase-quick-replies-tenant.sql sin correr), se cae a la versión global
// para no romper la feature; al correr el SQL, el aislamiento aplica solo.
const isMissingTenantCol = (msg?: string) => /tenant_id|column|schema cache/i.test(msg ?? '');

export async function GET() {
  const session = await getSessionAgent();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });

  const { data, error } = await supabaseAdmin
    .from('quick_replies')
    .select('*')
    .eq('tenant_id', session.tenant_id)
    .order('created_at', { ascending: true });

  if (error) {
    if (isMissingTenantCol(error.message)) {
      const { data: all, error: e2 } = await supabaseAdmin
        .from('quick_replies').select('*').order('created_at', { ascending: true });
      if (e2) return NextResponse.json({ error: e2.message }, { status: 500 });
      return NextResponse.json(all ?? []);
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json(data ?? []);
}

export async function POST(req: NextRequest) {
  const session = await getSessionAgent();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });

  const { title, content } = await req.json();
  if (!title?.trim() || !content?.trim()) {
    return NextResponse.json({ error: 'title y content son requeridos' }, { status: 400 });
  }

  const row = { title: title.trim(), content: content.trim(), tenant_id: session.tenant_id };
  let { data, error } = await supabaseAdmin.from('quick_replies').insert(row).select().single();
  if (error && isMissingTenantCol(error.message)) {
    const { tenant_id: _omit, ...withoutTenant } = row;
    ({ data, error } = await supabaseAdmin.from('quick_replies').insert(withoutTenant).select().single());
  }
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
}

export async function PUT(req: NextRequest) {
  const session = await getSessionAgent();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });

  const { id, title, content } = await req.json();
  if (!id) return NextResponse.json({ error: 'id requerido' }, { status: 400 });
  if (!title?.trim() || !content?.trim()) {
    return NextResponse.json({ error: 'title y content son requeridos' }, { status: 400 });
  }

  const values = { title: title.trim(), content: content.trim() };
  // Scope por tenant: un id de otro tenant no matchea.
  let { data, error } = await supabaseAdmin
    .from('quick_replies').update(values).eq('id', id).eq('tenant_id', session.tenant_id).select().maybeSingle();
  if (error && isMissingTenantCol(error.message)) {
    ({ data, error } = await supabaseAdmin
      .from('quick_replies').update(values).eq('id', id).select().maybeSingle());
  }
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: 'Respuesta rápida no encontrada' }, { status: 404 });
  return NextResponse.json(data);
}

export async function DELETE(req: NextRequest) {
  const session = await getSessionAgent();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });

  const { id } = await req.json();
  if (!id) return NextResponse.json({ error: 'id requerido' }, { status: 400 });

  let { error } = await supabaseAdmin
    .from('quick_replies').delete().eq('id', id).eq('tenant_id', session.tenant_id);
  if (error && isMissingTenantCol(error.message)) {
    ({ error } = await supabaseAdmin.from('quick_replies').delete().eq('id', id));
  }
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
