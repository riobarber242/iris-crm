import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { getSessionAgent, requireAgentOrAdmin } from '@/lib/current-agent';
import { resolveWaba, listTenantWabas } from '@/lib/waba';

// CRUD de plantillas de WhatsApp del tenant (tabla whatsapp_templates).
// El scope es SIEMPRE el tenant del usuario autenticado.
//  - GET: lista (cualquier sesión del tenant).
//  - POST/PUT/DELETE: solo admin y agent (operator → 403).
// service-role / sin RLS, como el resto del proyecto.
//
// Cada plantilla pertenece a UNA WABA (waba_id): es donde Meta la tiene aprobada.
// null = legacy (anterior a la migración de WABA): se muestra para cualquier línea.

const FIELDS = 'id, name, language, body, buttons, created_at, waba_id, approval_status, meta_template_id, status_synced_at';

// WABA con la que se guarda una plantilla nueva. Si el cliente mandó una, se
// valida que sea una WABA REAL del tenant (no se acepta un id arbitrario); si no
// mandó ninguna, se usa la del número default. Así el waba_id nunca depende de
// una carga manual: sale solo del alta.
async function resolveTemplateWaba(tenantId: string, requested: unknown): Promise<string | null> {
  const asked = String(requested ?? '').trim();
  if (asked) {
    const wabas = await listTenantWabas(tenantId);
    if (wabas.some((w) => w.wabaId === asked)) return asked;
  }
  return resolveWaba(tenantId);
}

// Normaliza los botones de respuesta rápida: array de hasta 2 textos no vacíos.
function parseButtons(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((b) => String(b ?? '').trim())
    .filter((b) => b.length > 0)
    .slice(0, 2);
}

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
  const buttons  = parseButtons(body?.buttons);

  if (!name) return NextResponse.json({ error: 'El nombre es requerido' }, { status: 400 });
  if (!text) return NextResponse.json({ error: 'El cuerpo es requerido' }, { status: 400 });

  // La plantilla nace atada a una WABA (la elegida en el panel o la del número
  // default). Sin esto el selector de campañas no puede filtrarla por línea.
  const wabaId = await resolveTemplateWaba(session.tenant_id, body?.waba_id);

  const { data, error } = await supabaseAdmin
    .from('whatsapp_templates')
    .insert({ tenant_id: session.tenant_id, name, language, body: text, buttons, waba_id: wabaId })
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
  const buttons  = parseButtons(body?.buttons);

  if (!name) return NextResponse.json({ error: 'El nombre es requerido' }, { status: 400 });
  if (!text) return NextResponse.json({ error: 'El cuerpo es requerido' }, { status: 400 });

  // Renombrar o cambiar el idioma convierte esto en OTRA plantilla para Meta: la
  // aprobación anterior deja de aplicar, así que el estado vuelve a "desconocido"
  // (punto gris) hasta la próxima sincronización.
  const { data: prev } = await supabaseAdmin
    .from('whatsapp_templates')
    .select('name, language').eq('id', id).eq('tenant_id', session.tenant_id).maybeSingle();
  const identityChanged = !!prev && (prev.name !== name || (prev.language || '') !== language);

  const { data, error } = await supabaseAdmin
    .from('whatsapp_templates')
    .update({
      name, language, body: text, buttons,
      ...(body?.waba_id !== undefined ? { waba_id: await resolveTemplateWaba(session.tenant_id, body?.waba_id) } : {}),
      ...(identityChanged ? { approval_status: null, meta_template_id: null, status_synced_at: null } : {}),
    })
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
