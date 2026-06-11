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

  const { contacts }: { contacts: ContactInput[] } = await req.json();

  if (!Array.isArray(contacts) || contacts.length === 0) {
    return NextResponse.json({ error: 'Array de contactos vacío' }, { status: 400 });
  }

  const rows = contacts
    .map((c) => ({ ...c, phone: normalizePhone(c.phone ?? '') }))
    .filter((c) => c.phone.length >= 7);

  if (rows.length === 0) {
    return NextResponse.json({ imported: 0, skipped: contacts.length });
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
  await logActivity({
    session,
    action:     ACTIVITY.CONTACT_IMPORTED,
    objectType: 'contact',
    objectId:   null,
    details:    { imported, skipped, total: rows.length },
  });

  return NextResponse.json({ imported, skipped });
}
