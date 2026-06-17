import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { getSessionAgent } from '@/lib/current-agent';
import { currentMonthStartISO, targetStatusFor } from '@/lib/contact-status';

export async function GET(request: Request) {
  // Acceso permitido: 1) staff logueado (botón "Ejecutar ahora" de Configuración)
  // o 2) el cron de Vercel, que manda Authorization: Bearer ${CRON_SECRET}.
  // Si CRON_SECRET no está configurado, no bloqueamos el cron programado (se
  // permite con warning) hasta que se configure el env en Vercel.
  const session = await getSessionAgent();
  const isStaff = !!session && (session.role === 'admin' || session.role === 'agent');
  const secret  = process.env.CRON_SECRET;
  const secretOk = !!secret && request.headers.get('authorization') === `Bearer ${secret}`;
  if (!isStaff && !secretOk) {
    if (secret) return new NextResponse('No autorizado', { status: 401 });
    console.warn('[cron/clasificar] Sin CRON_SECRET configurado: ejecución sin autenticar. Configurá CRON_SECRET en Vercel.');
  }

  try {
    const monthStart = currentMonthStartISO();

    const { data: contacts, error: cErr } = await supabaseAdmin
      .from('contacts')
      .select('id, status')
      .neq('status', 'bloqueado');

    if (cErr) return NextResponse.json({ error: cErr.message }, { status: 500 });
    if (!contacts || contacts.length === 0) return NextResponse.json({ updated: 0, detalle: [] });

    const [{ data: everVerif }, { data: monthVerif }] = await Promise.all([
      supabaseAdmin.from('comprobantes').select('contact_id').eq('estado', 'verificado'),
      supabaseAdmin.from('comprobantes').select('contact_id').eq('estado', 'verificado').gte('created_at', monthStart),
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
