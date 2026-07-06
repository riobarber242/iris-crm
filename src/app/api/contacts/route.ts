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

  // ?all=true o ?status=X → modo CONTEO (estimación de destinatarios de campaña).
  // Agregado en SQL con head:true (cuenta sin traer filas). Antes devolvía TODOS
  // los ids del tenant solo para hacer .length en el cliente → egress/memoria al
  // escalar. Devuelve { count }.
  if (all || status) {
    let query = supabaseAdmin.from('contacts')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', session.tenant_id)
      .neq('blocked', true);
    if (status)   query = query.eq('status', status);
    if (numberId) query = query.eq('whatsapp_number_id', numberId);
    const { count, error } = await query;
    if (error) return new NextResponse(error.message, { status: 500 });
    return NextResponse.json({ count: count ?? 0 });
  }

  // ── Modo LISTADO (agendados: con casino_username) ──────────────────────────
  // Paginación OPT-IN: si viene `limit`, se devuelve UNA página ordenada por
  // casino_username con búsqueda server-side (para la pantalla Contactos, que no
  // puede traer millones de filas). Sin `limit`, comportamiento LEGACY: lista
  // completa por created_at (el picker individual del wizard de campañas la
  // consume entera → hay que mantener compat).
  const SELECT_COLS = 'id, name, phone, status, casino_username, whatsapp_number_id, created_at';
  const limitParam  = parseInt(url.searchParams.get('limit') ?? '', 10);

  if (!Number.isInteger(limitParam) || limitParam <= 0) {
    const { data, error } = await supabaseAdmin
      .from('contacts')
      .select(SELECT_COLS)
      .eq('tenant_id', session.tenant_id)
      .not('casino_username', 'is', null)
      .neq('casino_username', '')
      .order('created_at', { ascending: false });
    if (error) return new NextResponse(error.message, { status: 500 });
    return NextResponse.json(data ?? []);
  }

  const limit  = Math.min(limitParam, 200);
  const offset = Math.max(0, parseInt(url.searchParams.get('offset') ?? '0', 10) || 0);
  const asc    = url.searchParams.get('sort') !== 'za'; // 'az' (default) | 'za'
  // Búsqueda: se sacan los chars estructurales del `.or()` (`,()`) y los wildcards
  // (`*%`) para no romper el filtro PostgREST; el resto va como ilike. (Mismo saneo
  // que la búsqueda de Comprobantes.) Vacío = sin búsqueda.
  const search = (url.searchParams.get('q') ?? '').replace(/[,()*%]/g, ' ').trim().slice(0, 60);

  let query = supabaseAdmin
    .from('contacts')
    .select(SELECT_COLS)
    .eq('tenant_id', session.tenant_id)
    .not('casino_username', 'is', null)
    .neq('casino_username', '');
  if (search) {
    query = query.or(`casino_username.ilike.*${search}*,name.ilike.*${search}*,phone.ilike.*${search}*`);
  }
  // Orden alfabético por casino_username (lo que muestra la lista) + id como
  // desempate estable, para que la paginación no repita ni saltee filas con igual
  // usuario. `.range()` acota el egress a una página.
  const { data, error } = await query
    .order('casino_username', { ascending: asc })
    .order('id', { ascending: asc })
    .range(offset, offset + limit - 1);
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

// PATCH /api/contacts — edición de un contacto desde la lista. Acepta name,
// phone y casino_username (todos opcionales). Scope estricto por tenant_id (el
// UPDATE filtra por tenant). Si se cambia el teléfono, se valida (≥7 dígitos) y
// se chequea que no choque con OTRO contacto del tenant.
export async function PATCH(request: Request) {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });

  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: 'JSON inválido en el body' }, { status: 400 });

  const id = String(body.id ?? '').trim();
  if (!id) return NextResponse.json({ error: 'Falta el id del contacto.' }, { status: 400 });

  const updates: Record<string, any> = {};

  if (body.name !== undefined) {
    updates.name = String(body.name).trim() || null;
  }

  if (body.casino_username !== undefined) {
    const cu = String(body.casino_username).trim();
    if (!cu) return NextResponse.json({ error: 'El usuario de casino no puede quedar vacío.' }, { status: 400 });
    updates.casino_username = cu;
  }

  if (body.phone !== undefined) {
    const phone = normalizePhone(String(body.phone));
    if (phone.length < 7) {
      return NextResponse.json({ error: 'El teléfono es obligatorio (mínimo 7 dígitos).' }, { status: 400 });
    }
    // Anti-duplicado: ningún OTRO contacto del tenant puede tener ese teléfono.
    const { data: dup } = await supabaseAdmin
      .from('contacts')
      .select('id')
      .eq('tenant_id', session.tenant_id)
      .eq('phone', phone)
      .neq('id', id)
      .maybeSingle();
    if (dup) {
      return NextResponse.json({ error: 'Ya existe otro contacto con ese teléfono.' }, { status: 409 });
    }
    updates.phone = phone;
  }

  if (body.status !== undefined) {
    if (!ALLOWED_STATUS.includes(String(body.status))) {
      return NextResponse.json({ error: 'Estado inválido.' }, { status: 400 });
    }
    updates.status = String(body.status);
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No hay cambios para guardar.' }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from('contacts')
    .update(updates)
    .eq('id', id)
    .eq('tenant_id', session.tenant_id)
    .select('id, name, phone, status, casino_username, whatsapp_number_id, created_at')
    .single();

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json({ error: 'Ya existe otro contacto con ese teléfono.' }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: 'Contacto no encontrado.' }, { status: 404 });
  }

  await logActivity({
    session,
    action:     ACTIVITY.CONTACT_EDITED,
    objectType: 'contact',
    objectId:   id,
    details:    { fields: Object.keys(updates) },
  });

  return NextResponse.json(data);
}

// DELETE /api/contacts — borra contacto(s) del tenant. Dos modos:
//   · individual: ?id=<uuid>
//   · lote:       body { ids: string[] }  → borra con .in('id', ids)
// OJO: por las FK ON DELETE CASCADE, esto borra también sus mensajes,
// comprobantes y leads. Scope estricto por tenant_id (no se puede borrar un
// contacto de otro tenant).
export async function DELETE(request: Request) {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });

  // Modo lote: si el body trae { ids: [...] }, borra el conjunto de una. Si no
  // hay body válido (DELETE con ?id= y sin cuerpo), cae al borrado individual.
  const body = await request.json().catch(() => null);
  const bulkIds = Array.isArray(body?.ids)
    ? (body.ids as unknown[]).filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    : null;

  if (bulkIds) {
    if (bulkIds.length === 0) {
      return NextResponse.json({ error: 'No se enviaron ids para eliminar.' }, { status: 400 });
    }
    // Borramos en lotes: supabase-js manda el `.in('id', [...])` como query string
    // en la URL del DELETE (~37 chars por uuid), así que "Seleccionar todo" con
    // cientos de contactos hacía explotar el largo de URL del gateway (PostgREST).
    // Lotes de 200 mantienen la URL chica y acotan el costo del ON DELETE CASCADE.
    const CHUNK = 200;
    let count = 0;
    const deletedIds: string[] = [];
    for (let i = 0; i < bulkIds.length; i += CHUNK) {
      const slice = bulkIds.slice(i, i + CHUNK);
      // El .eq('tenant_id') garantiza que ids de otros tenants se ignoran. El
      // .select() devuelve las filas borradas para saber cuántas fueron realmente.
      const { data: deleted, error: bulkErr } = await supabaseAdmin
        .from('contacts')
        .delete()
        .in('id', slice)
        .eq('tenant_id', session.tenant_id)
        .select('id');
      if (bulkErr) {
        // Log completo del error real (queda en los logs del server / Vercel).
        console.error('[contacts DELETE bulk] fallo al borrar lote', {
          code:       bulkErr.code,
          message:    bulkErr.message,
          details:    bulkErr.details,
          hint:       bulkErr.hint,
          chunkStart: i,
          chunkSize:  slice.length,
          total:      bulkIds.length,
          tenant_id:  session.tenant_id,
        });
        return NextResponse.json({ error: bulkErr.message }, { status: 500 });
      }
      count += deleted?.length ?? 0;
      deletedIds.push(...(deleted ?? []).map((d: any) => d.id));
    }
    await logActivity({
      session,
      action:     'contact_deleted',
      objectType: 'contact',
      objectId:   null,
      details:    { bulk: true, count, ids: deletedIds },
    });
    return NextResponse.json({ ok: true, deleted: count });
  }

  const id = new URL(request.url).searchParams.get('id')?.trim();
  if (!id) return NextResponse.json({ error: 'Falta el id del contacto.' }, { status: 400 });

  // Verificamos que exista en este tenant antes de borrar (para distinguir
  // 404 de un borrado real y para loguear el casino_username).
  const { data: existing } = await supabaseAdmin
    .from('contacts')
    .select('id, casino_username')
    .eq('id', id)
    .eq('tenant_id', session.tenant_id)
    .maybeSingle();
  if (!existing) {
    return NextResponse.json({ error: 'Contacto no encontrado.' }, { status: 404 });
  }

  const { error } = await supabaseAdmin
    .from('contacts')
    .delete()
    .eq('id', id)
    .eq('tenant_id', session.tenant_id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  await logActivity({
    session,
    action:     'contact_deleted',
    objectType: 'contact',
    objectId:   id,
    details:    { casino_username: existing.casino_username ?? null },
  });

  return NextResponse.json({ ok: true });
}
