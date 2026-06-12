import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { getSessionAgent } from '@/lib/current-agent';

// Gestión de números de WhatsApp del tenant (multi-número). Solo rol admin.
// El access_token NUNCA se devuelve al cliente: el GET expone solo has_token.

const FIELDS = 'id, label, phone_number_id, waba_id, active, is_default, created_at, access_token';

function sanitize(row: any) {
  const { access_token, ...rest } = row;
  return { ...rest, has_token: !!access_token };
}

async function requireAdmin(): Promise<{ session: any; error?: undefined } | { session?: undefined; error: NextResponse }> {
  const session = await getSessionAgent();
  if (!session) return { error: new NextResponse('No autenticado', { status: 401 }) };
  if (session.role !== 'admin') return { error: new NextResponse('Requiere rol admin', { status: 403 }) };
  return { session };
}

// GET: cualquier sesión (no solo admin) — Campañas e Import necesitan listar
// las líneas para sus selectores. La respuesta no expone secretos (has_token
// es booleano; el token nunca viaja). POST/PATCH/verify siguen admin-only.
export async function GET() {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });

  const { data, error: dbErr } = await supabaseAdmin
    .from('whatsapp_numbers')
    .select(FIELDS)
    .eq('tenant_id', session.tenant_id)
    .order('created_at', { ascending: true });

  if (dbErr) return new NextResponse(dbErr.message, { status: 500 });
  return NextResponse.json((data ?? []).map(sanitize));
}

export async function POST(request: Request) {
  const { session, error } = await requireAdmin();
  if (error) return error;

  const body = await request.json().catch(() => null);
  const label         = String(body?.label ?? '').trim();
  const phoneNumberId = String(body?.phone_number_id ?? '').trim();
  const accessToken   = String(body?.access_token ?? '').trim() || null;
  const wabaId        = String(body?.waba_id ?? '').trim() || null;

  if (!label) return new NextResponse('Falta el label', { status: 400 });
  if (!/^\d+$/.test(phoneNumberId)) {
    return new NextResponse('phone_number_id inválido: debe ser el ID numérico del número en Meta', { status: 400 });
  }

  // Duplicado: la unique constraint también lo frena, pero así el error es claro.
  const { data: dup } = await supabaseAdmin
    .from('whatsapp_numbers').select('id').eq('phone_number_id', phoneNumberId).maybeSingle();
  if (dup) return new NextResponse('Ese phone_number_id ya está registrado', { status: 409 });

  // El primer número del tenant queda como default automáticamente.
  const { count } = await supabaseAdmin
    .from('whatsapp_numbers').select('id', { count: 'exact', head: true })
    .eq('tenant_id', session.tenant_id);

  const { data, error: insErr } = await supabaseAdmin
    .from('whatsapp_numbers')
    .insert({
      tenant_id:       session.tenant_id,
      label,
      phone_number_id: phoneNumberId,
      access_token:    accessToken,
      waba_id:         wabaId,
      active:          true,
      is_default:      (count ?? 0) === 0,
    })
    .select(FIELDS)
    .single();

  if (insErr) return new NextResponse(insErr.message, { status: 500 });
  return NextResponse.json(sanitize(data));
}

export async function PATCH(request: Request) {
  const { session, error } = await requireAdmin();
  if (error) return error;

  const body = await request.json().catch(() => null);
  const id = body?.id as string | undefined;
  if (!id) return new NextResponse('Falta id', { status: 400 });

  const { data: num } = await supabaseAdmin
    .from('whatsapp_numbers')
    .select(FIELDS)
    .eq('id', id)
    .eq('tenant_id', session.tenant_id)
    .maybeSingle();
  if (!num) return new NextResponse('Número no encontrado', { status: 404 });

  // Marcar default: desmarcar el anterior ANTES de marcar este (el índice único
  // parcial idx_whatsapp_numbers_default exige ese orden). Debe estar activo:
  // resolveCreds solo considera defaults activos.
  if (body?.make_default === true && !num.is_default) {
    if (!num.active) {
      return new NextResponse('Activá el número antes de marcarlo como default', { status: 409 });
    }
    const { error: e1 } = await supabaseAdmin.from('whatsapp_numbers')
      .update({ is_default: false }).eq('tenant_id', session.tenant_id).eq('is_default', true);
    if (e1) return new NextResponse(e1.message, { status: 500 });
    const { error: e2 } = await supabaseAdmin.from('whatsapp_numbers')
      .update({ is_default: true }).eq('id', id);
    if (e2) return new NextResponse(e2.message, { status: 500 });
  }

  const updates: Record<string, any> = {};
  if (body?.label !== undefined) {
    const label = String(body.label).trim();
    if (!label) return new NextResponse('El label no puede quedar vacío', { status: 400 });
    updates.label = label;
  }
  if (body?.access_token !== undefined) updates.access_token = String(body.access_token).trim() || null;
  if (body?.waba_id !== undefined)      updates.waba_id      = String(body.waba_id).trim() || null;

  if (body?.active !== undefined) {
    const active = !!body.active;
    if (!active) {
      // El default no se desactiva (mover el default primero) y el último
      // activo tampoco (dejaría al tenant sin números para enviar).
      if (num.is_default) {
        return new NextResponse('El número default no se puede desactivar: marcá otro como default primero', { status: 409 });
      }
      const { count } = await supabaseAdmin.from('whatsapp_numbers')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', session.tenant_id).eq('active', true);
      if ((count ?? 0) <= 1) {
        return new NextResponse('No se puede desactivar el único número activo', { status: 409 });
      }
    }
    updates.active = active;
  }

  if (Object.keys(updates).length > 0) {
    const { error: upErr } = await supabaseAdmin.from('whatsapp_numbers')
      .update(updates).eq('id', id).eq('tenant_id', session.tenant_id);
    if (upErr) return new NextResponse(upErr.message, { status: 500 });
  }

  const { data: fresh, error: freshErr } = await supabaseAdmin
    .from('whatsapp_numbers').select(FIELDS).eq('id', id).single();
  if (freshErr) return new NextResponse(freshErr.message, { status: 500 });
  return NextResponse.json(sanitize(fresh));
}
