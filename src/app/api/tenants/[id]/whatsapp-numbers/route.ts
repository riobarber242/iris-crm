import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { requireAdmin } from '@/lib/current-agent';
import { encryptSecret, isSecretEncryptionConfigured } from '@/lib/secure-secret';
import { numbersQuota } from '@/lib/wa-numbers';

// Gestión ADMIN de los números de WhatsApp de OTRO tenant (panel /admin/tenants).
// A diferencia de /api/whatsapp-numbers (que scopea a la sesión del cliente), acá
// el scope es el tenant del path y el acceso es requireAdmin (admin global).
//
// El POST/PATCH aceptan y CIFRAN el app_secret (app_secret_enc) — la pieza que
// faltaba y causaba el 401 "Firma inválida" en clientes con app de Meta propia.
// Los secretos (token / app_secret) NUNCA viajan al cliente: el GET expone solo
// has_token / has_app_secret.

const FIELDS = 'id, label, phone_number_id, waba_id, active, is_default, created_at, access_token, access_token_enc, app_secret, app_secret_enc';

function sanitize(row: any) {
  const { access_token, access_token_enc, app_secret, app_secret_enc, ...rest } = row;
  return {
    ...rest,
    has_token:      !!(access_token || access_token_enc),
    has_app_secret: !!(app_secret || app_secret_enc),
  };
}

// GET: números del tenant del path.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await requireAdmin())) return new NextResponse('Requiere rol admin', { status: 403 });
  const { id: tenantId } = await params;

  const { data, error } = await supabaseAdmin
    .from('whatsapp_numbers')
    .select(FIELDS)
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: true });

  if (error) return new NextResponse(error.message, { status: 500 });
  return NextResponse.json((data ?? []).map(sanitize));
}

// POST: alta de un número en el tenant del path (con app_secret y cupo).
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await requireAdmin())) return new NextResponse('Requiere rol admin', { status: 403 });
  const { id: tenantId } = await params;

  const body = await request.json().catch(() => null);
  const label         = String(body?.label ?? '').trim();
  const phoneNumberId = String(body?.phone_number_id ?? '').trim();
  const accessToken   = String(body?.access_token ?? '').trim() || null;
  const wabaId        = String(body?.waba_id ?? '').trim() || null;
  const appSecret     = String(body?.app_secret ?? '').trim() || null;

  if (!label) return new NextResponse('Falta el label', { status: 400 });
  if (!/^\d+$/.test(phoneNumberId)) {
    return new NextResponse('phone_number_id inválido: debe ser el ID numérico del número en Meta', { status: 400 });
  }
  // Fail-closed en la ESCRITURA de secretos: no guardamos secretos nuevos en plano.
  if ((accessToken || appSecret) && !isSecretEncryptionConfigured()) {
    return new NextResponse('Falta SECRET_ENC_KEY (clave de cifrado) en el entorno', { status: 500 });
  }

  // Duplicado global (la unique constraint también lo frena; acá el error es claro).
  const { data: dup } = await supabaseAdmin
    .from('whatsapp_numbers').select('id').eq('phone_number_id', phoneNumberId).maybeSingle();
  if (dup) return new NextResponse('Ese phone_number_id ya está registrado', { status: 409 });

  // Cupo del tenant destino (misma regla que el alta self-service).
  const quota = await numbersQuota(tenantId);
  if (quota.full) {
    return new NextResponse(`Cupo de números alcanzado (${quota.max}). Subilo en Membresía.`, { status: 409 });
  }

  const { data, error: insErr } = await supabaseAdmin
    .from('whatsapp_numbers')
    .insert({
      tenant_id:        tenantId,
      label,
      phone_number_id:  phoneNumberId,
      // Secretos cifrados; las columnas planas quedan null en las altas nuevas.
      access_token:     null,
      access_token_enc: accessToken ? encryptSecret(accessToken) : null,
      app_secret:       null,
      app_secret_enc:   appSecret ? encryptSecret(appSecret) : null,
      waba_id:          wabaId,
      active:           true,
      is_default:       quota.count === 0,
    })
    .select(FIELDS)
    .single();

  if (insErr) return new NextResponse(insErr.message, { status: 500 });
  return NextResponse.json(sanitize(data));
}

// PATCH: editar un número del tenant del path. Admite label, waba_id, access_token,
// app_secret, active y make_default (admin tiene control total sobre la línea).
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await requireAdmin())) return new NextResponse('Requiere rol admin', { status: 403 });
  const { id: tenantId } = await params;

  const body = await request.json().catch(() => null);
  const id = body?.id as string | undefined;
  if (!id) return new NextResponse('Falta id', { status: 400 });

  const { data: num } = await supabaseAdmin
    .from('whatsapp_numbers')
    .select('id, is_default, active')
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (!num) return new NextResponse('Número no encontrado', { status: 404 });

  // Marcar default: desmarcar el anterior ANTES (índice único parcial). Debe estar
  // activo (resolveCreds solo considera defaults activos).
  if (body?.make_default === true && !num.is_default) {
    if (!num.active) {
      return new NextResponse('Activá el número antes de marcarlo como default', { status: 409 });
    }
    const { error: e1 } = await supabaseAdmin.from('whatsapp_numbers')
      .update({ is_default: false }).eq('tenant_id', tenantId).eq('is_default', true);
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
  if (body?.access_token !== undefined) {
    const t = String(body.access_token).trim();
    if (t && !isSecretEncryptionConfigured()) {
      return new NextResponse('Falta SECRET_ENC_KEY (clave de cifrado) en el entorno', { status: 500 });
    }
    updates.access_token     = null;
    updates.access_token_enc = t ? encryptSecret(t) : null;
  }
  if (body?.app_secret !== undefined) {
    const s = String(body.app_secret).trim();
    if (s && !isSecretEncryptionConfigured()) {
      return new NextResponse('Falta SECRET_ENC_KEY (clave de cifrado) en el entorno', { status: 500 });
    }
    updates.app_secret     = null;
    updates.app_secret_enc = s ? encryptSecret(s) : null;
  }
  if (body?.waba_id !== undefined) updates.waba_id = String(body.waba_id).trim() || null;

  if (body?.active !== undefined) {
    const active = !!body.active;
    if (!active) {
      // El default no se desactiva (mover el default primero) y el último activo tampoco.
      if (num.is_default) {
        return new NextResponse('El número default no se puede desactivar: marcá otro como default primero', { status: 409 });
      }
      const { count } = await supabaseAdmin.from('whatsapp_numbers')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId).eq('active', true);
      if ((count ?? 0) <= 1) {
        return new NextResponse('No se puede desactivar el único número activo', { status: 409 });
      }
    }
    updates.active = active;
  }

  if (Object.keys(updates).length > 0) {
    const { error: upErr } = await supabaseAdmin.from('whatsapp_numbers')
      .update(updates).eq('id', id).eq('tenant_id', tenantId);
    if (upErr) return new NextResponse(upErr.message, { status: 500 });
  }

  const { data: fresh, error: freshErr } = await supabaseAdmin
    .from('whatsapp_numbers').select(FIELDS).eq('id', id).single();
  if (freshErr) return new NextResponse(freshErr.message, { status: 500 });
  return NextResponse.json(sanitize(fresh));
}

// DELETE: borra una línea del tenant del path. Mismas guardas que el desactivar:
// no se puede borrar el default ni el único número activo.
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await requireAdmin())) return new NextResponse('Requiere rol admin', { status: 403 });
  const { id: tenantId } = await params;

  const body = await request.json().catch(() => null);
  const id = body?.id as string | undefined;
  if (!id) return new NextResponse('Falta id', { status: 400 });

  const { data: num } = await supabaseAdmin
    .from('whatsapp_numbers')
    .select('id, is_default, active')
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (!num) return new NextResponse('Número no encontrado', { status: 404 });

  if (num.is_default) {
    return new NextResponse('El número default no se puede eliminar: marcá otro como default primero', { status: 400 });
  }
  if (num.active) {
    const { count } = await supabaseAdmin.from('whatsapp_numbers')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId).eq('active', true);
    if ((count ?? 0) <= 1) {
      return new NextResponse('No se puede eliminar el único número activo', { status: 400 });
    }
  }

  const { error: delErr } = await supabaseAdmin.from('whatsapp_numbers')
    .delete().eq('id', id).eq('tenant_id', tenantId);
  if (delErr) return new NextResponse(delErr.message, { status: 500 });

  return NextResponse.json({ ok: true });
}
