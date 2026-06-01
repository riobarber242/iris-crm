import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';

export async function GET() {
  try {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    // 1. Get all contacts with casino_username that are not blocked
    const { data: contacts, error: cErr } = await supabaseAdmin
      .from('contacts')
      .select('id, casino_username, status')
      .not('casino_username', 'is', null)
      .neq('casino_username', '')
      .neq('blocked', true);

    if (cErr) return NextResponse.json({ error: cErr.message }, { status: 500 });
    if (!contacts || contacts.length === 0) return NextResponse.json({ updated: 0, detalle: [] });

    const ids = contacts.map((c: any) => c.id);

    // 2. Comprobantes verificados en los últimos 30 días por contacto
    const { data: recentVerif } = await supabaseAdmin
      .from('comprobantes')
      .select('contact_id')
      .eq('estado', 'verificado')
      .gte('created_at', thirtyDaysAgo.toISOString())
      .in('contact_id', ids);

    const recentSet = new Set((recentVerif ?? []).map((r: any) => r.contact_id));

    // 3. Comprobantes verificados históricos (todos los tiempos)
    const { data: allVerif } = await supabaseAdmin
      .from('comprobantes')
      .select('contact_id')
      .eq('estado', 'verificado')
      .in('contact_id', ids);

    const allSet = new Set((allVerif ?? []).map((r: any) => r.contact_id));

    // 4. Classify and update
    const detalle: { id: string; status: string }[] = [];

    for (const contact of contacts) {
      let newStatus: string;

      if (recentSet.has(contact.id)) {
        newStatus = 'cliente_activo';
      } else if (allSet.has(contact.id)) {
        newStatus = 'inactivo';
      } else {
        newStatus = 'nuevo';
      }

      if (newStatus !== contact.status) {
        await supabaseAdmin
          .from('contacts')
          .update({ status: newStatus })
          .eq('id', contact.id);
        detalle.push({ id: contact.id, status: newStatus });
      }
    }

    return NextResponse.json({ updated: detalle.length, detalle });
  } catch (err: any) {
    return NextResponse.json({ error: String(err?.message ?? err) }, { status: 500 });
  }
}
