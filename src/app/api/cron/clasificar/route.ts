import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { currentMonthStartISO, targetStatusFor } from '@/lib/contact-status';

export async function GET(request: Request) {
  const debug = new URL(request.url).searchParams.get('debug') === 'true';
  try {
    const monthStart = currentMonthStartISO();

    const { data: contacts, error: cErr } = await supabaseAdmin
      .from('contacts')
      .select('id, status')
      .neq('status', 'bloqueado');

    if (cErr) return NextResponse.json({ error: cErr.message }, { status: 500 });
    if (!contacts || contacts.length === 0) return NextResponse.json({ updated: 0, detalle: [], debug: { contacts: 0 } });

    const ids = contacts.map((c: any) => c.id);

    const [{ data: everVerif, error: everErr }, { data: monthVerif, error: monthErr }] = await Promise.all([
      supabaseAdmin.from('comprobantes').select('contact_id').eq('estado', 'verificado').in('contact_id', ids),
      supabaseAdmin.from('comprobantes').select('contact_id').eq('estado', 'verificado').gte('created_at', monthStart).in('contact_id', ids),
    ]);

    const everSet  = new Set((everVerif  ?? []).map((r: any) => r.contact_id));
    const monthSet = new Set((monthVerif ?? []).map((r: any) => r.contact_id));

    const toActivo:   string[] = [];
    const toInactivo: string[] = [];
    const toNuevo:    string[] = [];

    for (const contact of contacts) {
      const target = targetStatusFor(
        contact.status as string | null,
        monthSet.has(contact.id),
        everSet.has(contact.id),
      );
      if (!target) continue;
      if (target === 'cliente_activo') toActivo.push(contact.id);
      else if (target === 'inactivo')  toInactivo.push(contact.id);
      else                             toNuevo.push(contact.id);
    }

    if (debug) {
      return NextResponse.json({
        debug: {
          monthStart,
          contactsCandidatos: contacts.length,
          everErr: everErr?.message ?? null,
          monthErr: monthErr?.message ?? null,
          everSetSize: everSet.size,
          monthSetSize: monthSet.size,
          toActivo: toActivo.length,
          toInactivo: toInactivo.length,
          toNuevo: toNuevo.length,
          sampleContacts: contacts.slice(0, 3),
          everVerifSample: (everVerif ?? []).slice(0, 3),
          monthVerifSample: (monthVerif ?? []).slice(0, 3),
        }
      });
    }

    await Promise.all([
      toActivo.length   ? supabaseAdmin.from('contacts').update({ status: 'cliente_activo' }).in('id', toActivo)   : null,
      toInactivo.length ? supabaseAdmin.from('contacts').update({ status: 'inactivo'       }).in('id', toInactivo) : null,
      toNuevo.length    ? supabaseAdmin.from('contacts').update({ status: 'nuevo'           }).in('id', toNuevo)   : null,
    ]);

    const totalUpdated = toActivo.length + toInactivo.length + toNuevo.length;
    return NextResponse.json({
      updated: totalUpdated,
      detalle: { cliente_activo: toActivo.length, inactivo: toInactivo.length, nuevo: toNuevo.length },
    });
  } catch (err: any) {
    return NextResponse.json({ error: String(err?.message ?? err) }, { status: 500 });
  }
}
