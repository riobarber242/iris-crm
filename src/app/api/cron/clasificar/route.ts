import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';

// ─── Clasificación de contactos ────────────────────────────────────────────────
// Regla única (fuente de verdad): un contacto es 'cliente_activo' si y solo si
// tiene al menos un comprobante con estado 'verificado'. Sin comprobante
// verificado NUNCA se promueve automáticamente — se queda / vuelve a 'nuevo'.
//
// Los estados operativos 'en_proceso' (handoff a humano) y 'bloqueado' no se
// tocan salvo que el contacto gane cliente_activo al verificarse un comprobante.
// Este endpoint también sirve de backfill: corre una vez y reconcilia todo el
// histórico con la regla.
export async function GET() {
  try {
    // 1. Candidatos: todos los contactos no bloqueados.
    const { data: contacts, error: cErr } = await supabaseAdmin
      .from('contacts')
      .select('id, status')
      .neq('blocked', true);

    if (cErr) return NextResponse.json({ error: cErr.message }, { status: 500 });
    if (!contacts || contacts.length === 0) return NextResponse.json({ updated: 0, detalle: [] });

    // 2. Conjunto de contact_ids con al menos un comprobante verificado (cualquier fecha).
    const { data: verif } = await supabaseAdmin
      .from('comprobantes')
      .select('contact_id')
      .eq('estado', 'verificado');

    const verifiedSet = new Set((verif ?? []).map((r: any) => r.contact_id));

    // 3. Reconciliar el status con la regla.
    const detalle: { id: string; status: string }[] = [];

    for (const contact of contacts) {
      const hasVerified = verifiedSet.has(contact.id);
      let target: string | null = null;

      if (hasVerified && contact.status !== 'cliente_activo') {
        // Ganó estado de cliente al tener un comprobante verificado.
        target = 'cliente_activo';
      } else if (!hasVerified && contact.status === 'cliente_activo') {
        // Estaba marcado cliente_activo sin comprobante verificado (dato legacy/erróneo) → nuevo.
        target = 'nuevo';
      }

      if (target && target !== contact.status) {
        await supabaseAdmin.from('contacts').update({ status: target }).eq('id', contact.id);
        detalle.push({ id: contact.id, status: target });
      }
    }

    return NextResponse.json({ updated: detalle.length, detalle });
  } catch (err: any) {
    return NextResponse.json({ error: String(err?.message ?? err) }, { status: 500 });
  }
}
