import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { currentMonthStartISO, targetStatusFor } from '@/lib/contact-status';

// ─── Clasificación de contactos ────────────────────────────────────────────────
// Aplica la regla de 3 estados (ver lib/contact-status):
//   - nuevo          → nunca tuvo comprobante verificado
//   - cliente_activo → tiene ≥1 verificado en el mes calendario vigente
//   - inactivo       → tuvo verificados antes, pero ninguno este mes
// 'bloqueado' no se toca; 'en_proceso' solo asciende a cliente_activo.
// Corre periódicamente (y sirve de backfill) para reconciliar todo el histórico.
export async function GET() {
  try {
    const monthStart = currentMonthStartISO();

    // 1. Candidatos: todos los contactos no bloqueados.
    const { data: contacts, error: cErr } = await supabaseAdmin
      .from('contacts')
      .select('id, status')
      .neq('blocked', true);

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

    // 3. Reconciliar cada contacto con la regla.
    const detalle: { id: string; status: string }[] = [];

    for (const contact of contacts) {
      const target = targetStatusFor(
        contact.status as string | null,
        monthSet.has(contact.id),
        everSet.has(contact.id),
      );
      if (!target) continue;

      await supabaseAdmin.from('contacts').update({ status: target }).eq('id', contact.id);
      detalle.push({ id: contact.id, status: target });
    }

    return NextResponse.json({ updated: detalle.length, detalle });
  } catch (err: any) {
    return NextResponse.json({ error: String(err?.message ?? err) }, { status: 500 });
  }
}
