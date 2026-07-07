import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { getSessionAgent } from '@/lib/current-agent';
import { runCampaignBatch, tenantUsageSince, withinWindow } from '@/lib/campaigns/send-core';

// Auto-resume de campañas pausadas por el techo diario de Meta. Corre por cron:
// busca campañas en 'pausada' con reason 'daily_limit', y si el tenant ya tiene cupo
// libre en la ventana móvil de 24h, corre una tanda de envío. Al liberarse cupo
// gradualmente (24h después de cada envío), la campaña se completa sola sin que nadie
// tenga el navegador abierto.
//
// FRECUENCIA vs PLAN (importante para throughput real):
//   - Hobby: Vercel limita los crons a 1 vez/día (schedule "0 8 * * *"). Como cada
//     invocación de función corta a ~300s y el envío va espaciado (~2s/mensaje), una
//     corrida mueve ~135 mensajes. En Hobby ⇒ ~135 mensajes/día por esta vía → sirve
//     para volúmenes chicos, NO para reanudar cientos/miles sin el navegador abierto.
//   - Pro: cambiar el schedule de vercel.json a "*/10 * * * *" (cada 10 min) → ~135
//     por corrida × 144 corridas/día ⇒ mueve todo lo que Meta permita. Es lo que hace
//     falta para que el auto-resume funcione de verdad a volumen real.
//
// IMPORTANTE — por qué UNA sola tanda por corrida:
// runCampaignBatch tiene su propio presupuesto interno de 270s; si arrancáramos
// varias podríamos exceder maxDuration (300s) y que Vercel mate la función a mitad
// de una tanda. Los intentos se registran en campaign_recipients al FINAL de la
// tanda: si se cortara antes, esos contactos ya recibieron el mensaje pero no
// quedarían registrados → doble envío en la próxima corrida. Con una tanda por
// corrida siempre entra en el tiempo de ejecución. El cron horario continúa las
// campañas restantes en las siguientes corridas.
export const maxDuration = 300;

const WINDOW_MS = 24 * 60 * 60 * 1000;

export async function GET(request: Request) {
  // Mismo esquema que /api/cron/clasificar: staff logueado (para probar a mano) o
  // el cron de Vercel con Authorization: Bearer ${CRON_SECRET}.
  const session = await getSessionAgent();
  const isStaff = !!session && (session.role === 'admin' || session.role === 'agent');
  const secret  = process.env.CRON_SECRET;
  const secretOk = !!secret && request.headers.get('authorization') === `Bearer ${secret}`;
  if (!isStaff && !secretOk) {
    if (secret) return new NextResponse('No autorizado', { status: 401 });
    console.warn('[cron/resume-campaigns] Sin CRON_SECRET configurado: ejecución sin autenticar. Configurá CRON_SECRET en Vercel.');
  }

  try {
    // Campañas a retomar, más antigua primero (se termina una antes de empezar otra).
    // Motivos: 'daily_limit' (techo Meta), 'fuera_de_horario' (ventana), 'auto_resume'
    // (continuación de una tanda del cron cortada por tiempo).
    const { data: paused, error } = await supabaseAdmin
      .from('campaigns')
      .select('id, tenant_id, name, daily_cap, paused_reason, window_start_min, window_end_min')
      .eq('status', 'pausada')
      .in('paused_reason', ['daily_limit', 'fuera_de_horario', 'auto_resume'])
      .order('paused_at', { ascending: true });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!paused || paused.length === 0) return NextResponse.json({ resumed: 0, checked: 0 });

    const sinceISO = new Date(Date.now() - WINDOW_MS).toISOString();

    // Regla UNIFORME de reanudación (sirve para cualquier motivo, y así el caso
    // "pausada por límite Y fuera de horario" espera a que se cumplan AMBAS):
    //   retomar ⟺ dentro de la ventana horaria  ∧  hay cupo (used < cap, o cap null).
    // La primera campaña que pase ambas compuertas recibe UNA tanda (resumeMarker:
    // si se corta por tiempo queda 'auto_resume' para la próxima corrida).
    for (const camp of paused) {
      // Compuerta de HORARIO (barata, local).
      if (!withinWindow(camp.window_start_min, camp.window_end_min)) continue;

      // Compuerta de CUPO (solo si hay techo).
      const cap = camp.daily_cap != null ? Number(camp.daily_cap) : null;
      if (cap != null) {
        const used = await tenantUsageSince(camp.tenant_id, sinceISO);
        if (used >= cap) continue;
      }

      const res = await runCampaignBatch(camp.id, camp.tenant_id, { notifyOnPause: false, resumeMarker: true });
      const outcome = 'error' in res
        ? { error: res.error }
        : { done: res.done, paused: res.paused, reason: res.reason, sent: res.sent, usedToday: res.usedToday, cap: res.cap };

      return NextResponse.json({
        resumed: 1,
        checked: paused.length,
        campaign: { id: camp.id, name: camp.name, reason: camp.paused_reason },
        outcome,
      });
    }

    // Ninguna lista todavía (sin cupo y/o fuera de su ventana horaria).
    return NextResponse.json({ resumed: 0, checked: paused.length, note: 'ninguna con ventana+cupo disponibles aún' });
  } catch (err: any) {
    return NextResponse.json({ error: String(err?.message ?? err) }, { status: 500 });
  }
}
