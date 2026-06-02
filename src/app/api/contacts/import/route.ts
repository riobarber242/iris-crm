import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { inferProvinciaFromPhone } from '@/lib/phone-province';

type ContactInput = { phone: string; casino_username?: string; name?: string };

function normalizePhone(raw: string): string {
  return raw.replace(/[\s\-\(\)\.]/g, '');
}

export async function POST(req: NextRequest) {
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

  // upsert with ignoreDuplicates returns only the rows actually inserted
  const { data, error } = await supabaseAdmin
    .from('contacts')
    .upsert(
      rows.map((c) => {
        const provincia = inferProvinciaFromPhone(c.phone);
        return {
          phone: c.phone,
          ...(c.casino_username ? { casino_username: c.casino_username } : {}),
          ...(c.name ? { name: c.name } : {}),
          ...(provincia ? { provincia } : {}),
          status: 'nuevo',
        };
      }),
      { onConflict: 'phone', ignoreDuplicates: true },
    )
    .select('id');

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const imported = data?.length ?? 0;
  const skipped  = rows.length - imported;

  return NextResponse.json({ imported, skipped });
}
