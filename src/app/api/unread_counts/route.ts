import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { getSessionAgent } from '@/lib/current-agent';
import { classifyPending } from '@/lib/pending';

// Devuelve los pendientes según la regla de negocio (ver lib/pending.ts):
//   newPending       (🟠 naranja): bot terminó / entrante sin flujo de bot, sin leer.
//   recurringPending (🔴 rojo):    ya la agarró un humano (human_taken) o cliente reconocido.
// Sin filtro de fecha: mira TODOS los mensajes. Solo la lectura humana limpia.
// Agentes y admin cuentan TODOS los contactos del tenant (sin filtro por
// assigned_agent_id).
export async function GET() {
  try {
    const session = await getSessionAgent();
    if (!session) return new NextResponse('No autenticado', { status: 401 });

    // Snapshot por contacto (contacto + su ÚLTIMO mensaje) agregado en Postgres.
    // Antes esto eran DOS full-table selects (contacts + TODA la tabla messages,
    // sin filtro de fecha) para derivar el último msg por contacto en Node: ~84 KB
    // gzip por corrida, polleado cada 15 s. La RPC devuelve 1 fila por contacto.
    // classifyPending sigue en JS (única fuente de verdad, ver lib/pending.ts).
    const { data: snap, error: sErr } = await supabaseAdmin
      .rpc('fn_contacts_pending_snapshot', { p_tenant_id: session.tenant_id });
    if (sErr) return new NextResponse(sErr.message, { status: 500 });

    let newPending       = 0; // 🟠
    let recurringPending = 0; // 🔴
    for (const c of (snap ?? [])) {
      const level = classifyPending({
        lastRole:          c.last_role,
        lastMsgAt:         c.last_msg_at,
        lastReadAt:        c.last_read_at,
        conversationState: c.conversation_state,
        humanTaken:        c.human_taken,
      });
      if (level === 'red')         recurringPending++;
      else if (level === 'orange') newPending++;
    }

    // 4. Pendientes de la bandeja, separados por tipo (cargas / pagos). Se cuenta
    //    por tenant (agente y admin ven lo mismo, igual que los contactos de
    //    arriba); NO se filtra por contact_id: la lista de contactos del tenant
    //    puede tener cientos de IDs y meterlos todos en un `.in()` hace fallar la
    //    query en silencio (devolvía 0). `tipoFilter`=null → no filtra por tipo
    //    (degradación si la columna `tipo` aún no existe).
    async function countPendientes(tipoFilter: 'carga' | 'pago' | null): Promise<number | null> {
      let q = supabaseAdmin
        .from('comprobantes')
        .select('id', { count: 'exact', head: true })
        .eq('estado', 'pendiente')
        .eq('tenant_id', session!.tenant_id);
      if (tipoFilter) q = q.eq('tipo', tipoFilter);
      const { count, error } = await q;
      if (error) return null; // columna ausente u otro error → degradar
      return count ?? 0;
    }

    let cargasPending = await countPendientes('carga');
    let pagosPending  = await countPendientes('pago');
    // Si filtrar por tipo falló (migración sin correr), contamos todo como cargas.
    if (cargasPending === null) {
      cargasPending = (await countPendientes(null)) ?? 0;
      pagosPending  = 0;
    }
    pagosPending = pagosPending ?? 0;

    return NextResponse.json({
      total:               newPending + recurringPending,
      newPending,
      recurringPending,
      // `comprobantesPending` se mantiene como alias de cargas para compat.
      comprobantesPending: cargasPending,
      cargasPending,
      pagosPending,
    });
  } catch (err: any) {
    return new NextResponse(String(err?.message ?? err), { status: 500 });
  }
}
