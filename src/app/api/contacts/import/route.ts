import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { inferProvinciaFromPhone } from '@/lib/phone-province';
import { getSessionAgent } from '@/lib/current-agent';
import { logActivity, ACTIVITY } from '@/lib/activity-log';

type ContactInput = { phone: string; casino_username?: string; name?: string };

function normalizePhone(raw: string): string {
  return raw.replace(/[\s\-\(\)\.]/g, '');
}

export async function POST(req: NextRequest) {
  // Tenant del importador (de la sesión, nunca del cliente) — multi-tenant estricto.
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });
  const tenantId = session.tenant_id;

  const body = await req.json();

  // ── Cierre de una importación por lotes ────────────────────────────────────
  // El cliente manda muchos lotes con `batch: true` (que NO loguean) y, al
  // terminar, un único request `finalize` con los totales acumulados: así queda
  // UNA sola entrada en activity_log por importación, no cientos.
  if (body?.finalize) {
    await logActivity({
      session,
      action:     ACTIVITY.CONTACT_IMPORTED,
      objectType: 'contact',
      objectId:   null,
      details: {
        mode:     body.mode === 'update' ? 'update' : 'insert',
        imported: Number(body.imported) || 0,
        updated:  Number(body.updated)  || 0,
        skipped:  Number(body.skipped)  || 0,
        total:    Number(body.total)    || 0,
        batched:  true,
      },
    });
    return NextResponse.json({ ok: true });
  }

  // `batch: true` → es un lote intermedio de una importación grande: hace el
  // upsert de SOLO estas filas (nunca dependió del archivo completo) y NO loguea
  // (el finalize de arriba registra el total). Sin `batch` → import de una sola
  // tanda (compatibilidad): loguea como siempre.
  const { contacts, mode, whatsapp_number_id, batch }: { contacts: ContactInput[]; mode?: string; whatsapp_number_id?: string; batch?: boolean } = body;

  if (!Array.isArray(contacts) || contacts.length === 0) {
    return NextResponse.json({ error: 'Array de contactos vacío' }, { status: 400 });
  }

  // Línea a asignar (opcional): debe ser un número ACTIVO del tenant; si no
  // valida, se importa sin línea (null), igual que antes de multi-número.
  let lineId: string | null = null;
  if (whatsapp_number_id) {
    const { data: num } = await supabaseAdmin
      .from('whatsapp_numbers').select('id')
      .eq('id', whatsapp_number_id).eq('tenant_id', tenantId).eq('active', true).maybeSingle();
    lineId = num?.id ?? null;
  }

  const rows = contacts
    .map((c) => ({ ...c, phone: normalizePhone(c.phone ?? '') }))
    .filter((c) => c.phone.length >= 7);

  if (rows.length === 0) {
    return NextResponse.json({ imported: 0, updated: 0, skipped: contacts.length });
  }

  // ── Modo actualizar: completa campos vacíos de contactos existentes ─────────
  // phone + tenant_id son la clave y nunca se tocan. Solo se escriben name,
  // casino_username y provincia cuando el CSV los trae y el contacto los tiene
  // vacíos. Los teléfonos que no existen se insertan igual que en modo insert.
  if (mode === 'update') {
    // Dedupe por teléfono (un CSV puede repetir filas; gana la primera).
    const byPhone = new Map<string, (typeof rows)[number]>();
    for (const c of rows) if (!byPhone.has(c.phone)) byPhone.set(c.phone, c);
    const unique = Array.from(byPhone.values());

    // Contactos existentes del tenant para esos teléfonos (lookup en chunks
    // para no exceder el límite de URL de PostgREST con CSVs grandes).
    const existing = new Map<string, { id: string; name: string | null; casino_username: string | null; provincia: string | null; whatsapp_number_id: string | null }>();
    const phones = unique.map((c) => c.phone);
    for (let i = 0; i < phones.length; i += 200) {
      const { data, error } = await supabaseAdmin
        .from('contacts')
        .select('id, phone, name, casino_username, provincia, whatsapp_number_id')
        .eq('tenant_id', tenantId)
        .in('phone', phones.slice(i, i + 200));
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      for (const c of data ?? []) existing.set(c.phone, c);
    }

    // Nuevos → mismo insert que el modo insert.
    const newRows = unique.filter((c) => !existing.has(c.phone));
    let imported = 0;
    if (newRows.length > 0) {
      const { data, error } = await supabaseAdmin
        .from('contacts')
        .upsert(
          newRows.map((c) => {
            const provincia = inferProvinciaFromPhone(c.phone);
            return {
              phone: c.phone,
              tenant_id: tenantId,
              whatsapp_number_id: lineId,
              ...(c.casino_username ? { casino_username: c.casino_username } : {}),
              ...(c.name ? { name: c.name } : {}),
              ...(provincia ? { provincia } : {}),
              status: 'nuevo',
            };
          }),
          { onConflict: 'phone,tenant_id', ignoreDuplicates: true },
        )
        .select('id');
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      imported = data?.length ?? 0;
    }

    // Existentes → armar el patch solo con campos vacíos que el CSV completa.
    let skipped = 0;
    const pending: { id: string; patch: Record<string, string> }[] = [];
    for (const c of unique) {
      const ex = existing.get(c.phone);
      if (!ex) continue;
      const patch: Record<string, string> = {};
      if (c.name && !ex.name) patch.name = c.name;
      if (c.casino_username && !ex.casino_username) patch.casino_username = c.casino_username;
      const provincia = inferProvinciaFromPhone(c.phone);
      if (provincia && !ex.provincia) patch.provincia = provincia;
      // Línea: solo se asigna a los que no tienen; nunca se pisa la existente.
      if (lineId && !ex.whatsapp_number_id) patch.whatsapp_number_id = lineId;
      if (Object.keys(patch).length > 0) pending.push({ id: ex.id, patch });
      else skipped++;
    }

    let updated = 0;
    for (let i = 0; i < pending.length; i += 20) {
      const chunk = pending.slice(i, i + 20);
      const results = await Promise.all(
        chunk.map(({ id, patch }) =>
          supabaseAdmin.from('contacts').update(patch).eq('id', id).eq('tenant_id', tenantId),
        ),
      );
      for (const r of results) {
        if (r.error) return NextResponse.json({ error: r.error.message }, { status: 500 });
      }
      updated += chunk.length;
    }

    if (!batch) {
      await logActivity({
        session,
        action:     ACTIVITY.CONTACT_IMPORTED,
        objectType: 'contact',
        objectId:   null,
        details:    { mode: 'update', imported, updated, skipped, total: unique.length },
      });
    }

    return NextResponse.json({ imported, updated, skipped });
  }

  // upsert with ignoreDuplicates returns only the rows actually inserted.
  // La unicidad de contacts es (phone, tenant_id) desde la migración multi-tenant,
  // así que el onConflict y el tenant_id deben ir acordes (antes faltaban → 500).
  const { data, error } = await supabaseAdmin
    .from('contacts')
    .upsert(
      rows.map((c) => {
        const provincia = inferProvinciaFromPhone(c.phone);
        return {
          phone: c.phone,
          tenant_id: tenantId,
          whatsapp_number_id: lineId,
          ...(c.casino_username ? { casino_username: c.casino_username } : {}),
          ...(c.name ? { name: c.name } : {}),
          ...(provincia ? { provincia } : {}),
          status: 'nuevo',
        };
      }),
      { onConflict: 'phone,tenant_id', ignoreDuplicates: true },
    )
    .select('id');

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const imported = data?.length ?? 0;
  const skipped  = rows.length - imported;

  // Registro de actividad: alta masiva de contactos por una persona.
  if (!batch) {
    await logActivity({
      session,
      action:     ACTIVITY.CONTACT_IMPORTED,
      objectType: 'contact',
      objectId:   null,
      details:    { imported, skipped, total: rows.length },
    });
  }

  return NextResponse.json({ imported, skipped });
}
