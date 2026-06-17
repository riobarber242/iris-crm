import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { getSessionAgent } from '@/lib/current-agent';

// Respuestas rápidas, aisladas por tenant. Requiere sesión y filtra todo por
// el tenant_id de la sesión (un usuario nunca ve/edita las de otro tenant).

export async function GET() {
  const session = await getSessionAgent();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });

  const { data, error } = await supabaseAdmin
    .from('quick_replies')
    .select('*')
    .eq('tenant_id', session.tenant_id)
    .order('created_at', { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data ?? []);
}

export async function POST(req: NextRequest) {
  const session = await getSessionAgent();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });

  const { title, content } = await req.json();
  if (!title?.trim() || !content?.trim()) {
    return NextResponse.json({ error: 'title y content son requeridos' }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from('quick_replies')
    .insert({ title: title.trim(), content: content.trim(), tenant_id: session.tenant_id })
    .select()
    .single();
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

  // Scope por tenant: un id de otro tenant no matchea.
  const { data, error } = await supabaseAdmin
    .from('quick_replies')
    .update({ title: title.trim(), content: content.trim() })
    .eq('id', id)
    .eq('tenant_id', session.tenant_id)
    .select()
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: 'Respuesta rápida no encontrada' }, { status: 404 });
  return NextResponse.json(data);
}

export async function DELETE(req: NextRequest) {
  const session = await getSessionAgent();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });

  const { id } = await req.json();
  if (!id) return NextResponse.json({ error: 'id requerido' }, { status: 400 });

  const { error } = await supabaseAdmin
    .from('quick_replies')
    .delete()
    .eq('id', id)
    .eq('tenant_id', session.tenant_id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
