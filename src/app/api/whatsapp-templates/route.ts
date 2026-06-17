import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { getSessionAgent, requireAgentOrAdmin } from '@/lib/current-agent';

// CRUD de plantillas de WhatsApp del tenant (tabla whatsapp_templates).
// El scope es SIEMPRE el tenant del usuario autenticado.
//  - GET: lista (cualquier sesión del tenant).
//  - POST/PUT/DELETE: solo admin y agent (operator → 403).
// service-role / sin RLS, como el resto del proyecto.

const FIELDS = 'id, name, language, body, created_at';

// GET: plantillas del tenant.
export async function GET() {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });

  const { data, error } = await supabaseAdmin
    .from('whatsapp_templates')
    .select(FIELDS)
    .eq('tenant_id', session.tenant_id)
    .order('created_at', { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data ?? []);
}

// POST: crear una plantilla en el tenant.
export async function POST(request: Request) {
  const session = await requireAgentOrAdmin();
  if (!session) return new NextResponse('Requiere rol admin o agent', { status: 403 });

  const body = await request.json().catch(() => null);
  const name     = String(body?.name ?? '').trim();
  const text     = String(body?.body ?? '').trim();
  const language = String(body?.language ?? '').trim() || 'es';

  if (!name) return NextResponse.json({ error: 'El nombre es requerido' }, { status: 400 });
  if (!text) return NextResponse.json({ error: 'El cuerpo es requerido' }, { status: 400 });

  const { data, error } = await supabaseAdmin
    .from('whatsapp_templates')
    .insert({ tenant_id: session.tenant_id, name, language, body: text })
    .select(FIELDS)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
}

// PUT: editar una plantilla del tenant (doble filtro id + tenant_id).
export async function PUT(request: Request) {
  const session = await requireAgentOrAdmin();
  if (!session) return new NextResponse('Requiere rol admin o agent', { status: 403 });

  const body = await request.json().catch(() => null);
  const id = body?.id as string | undefined;
  if (!id) return NextResponse.json({ error: 'id requerido' }, { status: 400 });

  const name     = String(body?.name ?? '').trim();
  const text     = String(body?.body ?? '').trim();
  const language = String(body?.language ?? '').trim() || 'es';

  if (!name) return NextResponse.json({ error: 'El nombre es requerido' }, { status: 400 });
  if (!text) return NextResponse.json({ error: 'El cuerpo es requerido' }, { status: 400 });

  const { data, error } = await supabaseAdmin
    .from('whatsapp_templates')
    .update({ name, language, body: text })
    .eq('id', id)
    .eq('tenant_id', session.tenant_id)
    .select(FIELDS)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: 'Plantilla no encontrada' }, { status: 404 });
  return NextResponse.json(data);
}

// DELETE: borrar una plantilla del tenant (doble filtro id + tenant_id).
export async function DELETE(request: Request) {
  const session = await requireAgentOrAdmin();
  if (!session) return new NextResponse('Requiere rol admin o agent', { status: 403 });

  const body = await request.json().catch(() => null);
  const id = body?.id as string | undefined;
  if (!id) return NextResponse.json({ error: 'id requerido' }, { status: 400 });

  const { error } = await supabaseAdmin
    .from('whatsapp_templates')
    .delete()
    .eq('id', id)
    .eq('tenant_id', session.tenant_id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
