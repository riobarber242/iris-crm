import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { currentMonthStartISO, targetStatusFor } from '@/lib/contact-status';

export async function GET() {
  try {
    const monthStart = currentMonthStartISO();

    // 1. Candidatos: todos los contactos no bloqueados.
    const { data: contacts, error: cErr } = await supabaseAdmin
      .from('contacts')
      .select('id, status')
      .neq('status', 'bloqueado');   // FIX: era .neq('blocked', true) — columna inexistente

    if (cErr) return NextResponse.json({ error: cErr.message }, { status: 500 });
    if (!contacts || contacts.length === 0) return NextResponse.json({ updated: 0, detalle: [] });

    const ids = contacts.map((c: any) => c.id);

    // 2. Comprobantes verificados — histórico y los del mes vigente.
    const [{ data: everVerif }, { data: monthVerif }] = await Promise.all([
      supabaseAdmin.from('comprobantes').select('contact_id')
        .eq('estado', 'verificado').in('contact_id', ids),
      supabaseAdmin.from('comprobantes').select('contact_id')
        .eq('estado', 'verificado').gte('created_at', monthStart).in('contact_id', ids),
    ]);

    const everSet  = new Set((everVerif  ?? []).map((r: any) => r.contact_id));
    const monthSet = new Set((monthVerif ?? []).map((r: any) => r.contact_id));

    // 3. Agrupar los ids por status objetivo para hacer bulk updates (evita timeout).
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

    console.log('[cron/clasificar] contactos candidatos:', contacts.length);
    console.log('[cron/clasificar] everSet size:', everSet.size, 'monthSet size:', monthSet.size);
    console.log('[cron/clasificar] toActivo:', toActivo.length, 'toInactivo:', toInactivo.length, 'toNuevo:', toNuevo.length);

    // 4. Bulk updates — 3 queries en lugar de N.
    const updates = await Promise.all([
      toActivo.length   ? supabaseAdmin.from('contacts').update({ status: 'cliente_activo' }).in('id', toActivo)   : null,
      toInactivo.length ? supabaseAdmin.from('contacts').update({ status: 'inactivo'       }).in('id', toInactivo) : null,
      toNuevo.length    ? supabaseAdmin.from('contacts').update({ status: 'nuevo'           }).in('id', toNuevo)   : null,
    ]);

    const totalUpdated = toActivo.length + toInactivo.length + toNuevo.length;

    return NextResponse.json({
      updated: totalUpdated,
      detalle: {
        cliente_activo: toActivo.length,
        inactivo:       toInactivo.length,
        nuevo:          toNuevo.length,
      },
    });
  } catch (err: any) {
    return NextResponse.json({ error: String(err?.message ?? err) }, { status: 500 });
  }
}
