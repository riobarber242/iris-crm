import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { getSessionAgent } from '@/lib/current-agent';
import { inferProvinciaFromPhone } from '@/lib/phone-province';
import { logActivity, ACTIVITY } from '@/lib/activity-log';

// Estados válidos de un contacto (alineado con la regla de contact-status y el
// selector de la UI). 'bloqueado' es solo un valor más: sin comportamiento
// especial (no toca la columna `blocked`).
const ALLOWED_STATUS = ['nuevo', 'cliente_activo', 'inactivo', 'en_proceso', 'bloqueado'];

// Normalización local del teléfono (misma regla que el import CSV): quita
// separadores comunes. Local a propósito para no tocar otros endpoints.
function normalizePhone(raw: string): string {
  return (raw ?? '').replace(/[\s\-().]/g, '');
}

export async function GET(request: Request) {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });

  const url      = new URL(request.url);
  const status   = url.searchParams.get('status');
  const all      = url.searchParams.get('all') === 'true';
  const numberId = url.searchParams.get('number'); // filtro por línea de WhatsApp

  // ?all=true or ?status=X → count mode for campaign recipient estimation
  if (all || status) {
    let query = supabaseAdmin.from('contacts').select('id')
      .eq('tenant_id', session.tenant_id)
      .neq('blocked', true);
    if (status)   query = query.eq('status', status);
    if (numberId) query = query.eq('whatsapp_number_id', numberId);
    const { data, error } = await query;
    if (error) return new NextResponse(error.message, { status: 500 });
    return NextResponse.json(data ?? []);
  }

  // Default: agendados (with casino_username) for /contacts page
  const { data, error } = await supabaseAdmin
    .from('contacts')
    .select('id, phone, status, casino_username, whatsapp_number_id, created_at')
    .eq('tenant_id', session.tenant_id)
    .not('casino_username', 'is', null)
    .neq('casino_username', '')
    .order('created_at', { ascending: false });

  if (error) return new NextResponse(error.message, { status: 500 });
  return NextResponse.json(data ?? []);
}

// POST /api/contacts — alta individual de un contacto. Scope estricto por
// tenant_id (de la sesión, nunca del cliente). usuario de casino y teléfono son
// obligatorios. Provincia: si el body la trae se respeta; si no, se infiere del
// teléfono. Línea: se asigna la línea por defecto (activa) del tenant.
export async function POST(request: Request) {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });

  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: 'JSON inválido en el body' }, { status: 400 });

  const casino_username = String(body.casino_username ?? '').trim();
  const phone = normalizePhone(String(body.phone ?? ''));
  const status = String(body.status ?? 'nuevo');
  const provinciaInput = body.provincia != null ? String(body.provincia).trim() : '';

  // Validaciones obligatorias.
  if (!casino_username) {
    return NextResponse.json({ error: 'El usuario de casino es obligatorio.' }, { status: 400 });
  }
  if (phone.length < 7) {
    return NextResponse.json({ error: 'El teléfono es obligatorio (mínimo 7 dígitos).' }, { status: 400 });
  }
  if (!ALLOWED_STATUS.includes(status)) {
    return NextResponse.json({ error: 'Estado inválido.' }, { status: 400 });
  }

  // Anti-duplicado: no puede existir ese teléfono en este tenant.
  const { data: dup } = await supabaseAdmin
    .from('contacts')
    .select('id')
    .eq('tenant_id', session.tenant_id)
    .eq('phone', phone)
    .maybeSingle();
  if (dup) {
    return NextResponse.json({ error: 'Ya existe un contacto con ese teléfono.' }, { status: 409 });
  }

  // Provincia: la del body manda; si vino vacía, se infiere del teléfono (puede
  // quedar null si el prefijo no matchea).
  const provincia = provinciaInput || inferProvinciaFromPhone(phone);

  // Línea por defecto del tenant (activa). Si no hay, queda sin línea (null).
  const { data: defaultLine } = await supabaseAdmin
    .from('whatsapp_numbers')
    .select('id')
    .eq('tenant_id', session.tenant_id)
    .eq('is_default', true)
    .eq('active', true)
    .maybeSingle();

  const { data, error } = await supabaseAdmin
    .from('contacts')
    .insert({
      phone,
      tenant_id:          session.tenant_id,
      casino_username,
      status,
      whatsapp_number_id: defaultLine?.id ?? null,
      ...(provincia ? { provincia } : {}),
    })
    .select('*')
    .single();

  if (error) {
    // 23505 = unique_violation (race condition contra el chequeo de arriba).
    if (error.code === '23505') {
      return NextResponse.json({ error: 'Ya existe un contacto con ese teléfono.' }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  await logActivity({
    session,
    action:     ACTIVITY.CONTACT_CREATED,
    objectType: 'contact',
    objectId:   data.id,
    details:    { status, provincia: provincia ?? null, has_line: !!defaultLine?.id },
  });

  return NextResponse.json(data, { status: 201 });
}
