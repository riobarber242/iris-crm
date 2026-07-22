import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { getSessionAgent } from '@/lib/current-agent';
import { currentMonthStartISO, targetStatusFor } from '@/lib/contact-status';

// Reclasificación diaria de contactos: nuevo / cliente_activo / inactivo.
//
// Camino principal: la RPC reclassify_contacts (supabase-clasificar-contactos-rpc.sql),
// que resuelve todo en SQL. Antes esto se hacía trayendo contactos y comprobantes
// a memoria con selects sin paginar: PostgREST corta en 1000 filas, así que el
// cron veía 1.000 de 55.252 contactos y 1.000 de 2.823 comprobantes verificados,
// y mezclaba todos los tenants. Eso no solo dejaba contactos sin reclasificar:
// DEGRADABA a 'nuevo' a clientes con cargas cuyos comprobantes quedaban fuera de
// la ventana, todas las noches.
//
// Fallback: si la RPC no está migrada todavía, se hace en TS pero paginado y
// tenant por tenant (mismo criterio, sin truncado). Es más lento, pero correcto.

// PostgREST devuelve como máximo 1000 filas por request: para leer una tabla
// entera hay que pedirla por tramos con Range. Esta es la pieza que faltaba.
const PAGE = 1000;

async function fetchAllPaged<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

// Fallback en TS, por tenant y paginado. Devuelve cuántos pasaron a cada estado.
async function reclasificarEnTs(monthStart: string): Promise<Record<string, number>> {
  const detalle: Record<string, number> = { cliente_activo: 0, inactivo: 0, nuevo: 0 };

  const { data: tenants } = await supabaseAdmin.from('tenants').select('id');
  for (const t of tenants ?? []) {
    const tenantId = (t as any).id as string;

    const contacts = await fetchAllPaged<{ id: string; status: string | null }>((from, to) =>
      supabaseAdmin.from('contacts').select('id, status')
        .eq('tenant_id', tenantId).neq('status', 'bloqueado')
        .order('id', { ascending: true }).range(from, to),
    );
    if (contacts.length === 0) continue;

    const verificados = await fetchAllPaged<{ contact_id: string; created_at: string }>((from, to) =>
      supabaseAdmin.from('comprobantes').select('contact_id, created_at')
        .eq('tenant_id', tenantId).eq('estado', 'verificado')
        .order('id', { ascending: true }).range(from, to),
    );

    const everSet  = new Set<string>();
    const monthSet = new Set<string>();
    for (const v of verificados) {
      if (!v.contact_id) continue;
      everSet.add(v.contact_id);
      if (v.created_at >= monthStart) monthSet.add(v.contact_id);
    }

    const porDestino: Record<string, string[]> = { cliente_activo: [], inactivo: [], nuevo: [] };
    for (const c of contacts) {
      const target = targetStatusFor(c.status, monthSet.has(c.id), everSet.has(c.id));
      if (target) porDestino[target].push(c.id);
    }

    // Los updates también se chunkean: un .in() con miles de uuid revienta el
    // largo de la URL de PostgREST (414) y fallaría en silencio.
    for (const [destino, ids] of Object.entries(porDestino)) {
      for (let i = 0; i < ids.length; i += 200) {
        const slice = ids.slice(i, i + 200);
        const { error } = await supabaseAdmin.from('contacts').update({ status: destino }).in('id', slice);
        if (error) throw new Error(`update ${destino}: ${error.message}`);
        detalle[destino] += slice.length;
      }
    }
  }

  return detalle;
}

export async function GET(request: Request) {
  // Acceso permitido: 1) staff logueado (botón "Ejecutar ahora" de Configuración)
  // o 2) el cron de Vercel, que manda Authorization: Bearer ${CRON_SECRET}.
  // Fail-closed (igual que retry-media / backfill-thumbs): sin auth válida → 401.
  const session = await getSessionAgent();
  const isStaff = !!session && (session.role === 'admin' || session.role === 'agent');
  const secret  = process.env.CRON_SECRET;
  const secretOk = !!secret && request.headers.get('authorization') === `Bearer ${secret}`;
  if (!isStaff && !secretOk) return new NextResponse('No autorizado', { status: 401 });

  try {
    const monthStart = currentMonthStartISO();

    // 1) SQL (preferido): sin traer filas, sin truncado, sin límite de escala.
    const { data, error } = await supabaseAdmin.rpc('reclassify_contacts', { month_start: monthStart });

    if (!error && Array.isArray(data)) {
      const detalle: Record<string, number> = { cliente_activo: 0, inactivo: 0, nuevo: 0 };
      for (const row of data as any[]) detalle[row.nuevo_status] = Number(row.actualizados) || 0;
      const updated = Object.values(detalle).reduce((a, b) => a + b, 0);
      console.log(`[cron/clasificar] via RPC → ${JSON.stringify(detalle)}`);
      return NextResponse.json({ updated, detalle, via: 'rpc' });
    }

    console.warn('[cron/clasificar] RPC no disponible (¿migración pendiente?), uso el camino TS:', error?.message);
    const detalle = await reclasificarEnTs(monthStart);
    const updated = Object.values(detalle).reduce((a, b) => a + b, 0);
    console.log(`[cron/clasificar] via TS → ${JSON.stringify(detalle)}`);
    return NextResponse.json({ updated, detalle, via: 'ts' });
  } catch (err: any) {
    return NextResponse.json({ error: String(err?.message ?? err) }, { status: 500 });
  }
}
