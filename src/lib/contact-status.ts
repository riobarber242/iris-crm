import { supabaseAdmin } from './db';

// ─── Regla de estados de contacto (fuente de verdad única) ──────────────────────
// Basada exclusivamente en comprobantes verificados:
//   - 'nuevo'          → nunca tuvo un comprobante verificado.
//   - 'cliente_activo' → tiene ≥1 comprobante verificado en el mes calendario vigente.
//   - 'inactivo'       → tuvo verificados en meses anteriores, pero ninguno este mes.
//
// Estados operativos preservados: 'bloqueado' nunca se toca; 'en_proceso' (handoff
// a humano) solo se promueve a 'cliente_activo' si corresponde, nunca se degrada.

// Argentina es UTC-3 fijo (sin DST desde 2009). La medianoche del 1ro de Argentina
// equivale a las 03:00 UTC de ese día.
const ART_OFFSET_MS = 3 * 60 * 60 * 1000;

export function currentMonthStartISO(): string {
  const argNow = new Date(Date.now() - ART_OFFSET_MS);
  const y = argNow.getUTCFullYear();
  const m = argNow.getUTCMonth();
  return new Date(Date.UTC(y, m, 1, 3, 0, 0, 0)).toISOString();
}

export type ContactStatus = 'nuevo' | 'cliente_activo' | 'inactivo';

export function deriveStatus(hasVerifiedThisMonth: boolean, hasVerifiedEver: boolean): ContactStatus {
  if (hasVerifiedThisMonth) return 'cliente_activo';
  if (hasVerifiedEver)      return 'inactivo';
  return 'nuevo';
}

// Devuelve el status objetivo a aplicar a un contacto, o null si no hay que cambiarlo
// (respeta 'bloqueado' y no degrada 'en_proceso').
export function targetStatusFor(
  currentStatus: string | null,
  hasVerifiedThisMonth: boolean,
  hasVerifiedEver: boolean,
): ContactStatus | null {
  if (currentStatus === 'bloqueado') return null;

  const target = deriveStatus(hasVerifiedThisMonth, hasVerifiedEver);

  // No degradar un handoff operativo en curso; solo permitir que ascienda a cliente_activo.
  if (currentStatus === 'en_proceso' && target !== 'cliente_activo') return null;

  return target === currentStatus ? null : target;
}

// Recalcula y persiste el status de UN contacto según sus comprobantes verificados.
// Pensado para llamarse tras verificar/rechazar un comprobante.
export async function reconcileContactStatus(contactId: string): Promise<void> {
  const monthStart = currentMonthStartISO();

  const [contactRes, everRes, monthRes] = await Promise.all([
    supabaseAdmin.from('contacts').select('status, blocked').eq('id', contactId).maybeSingle(),
    supabaseAdmin.from('comprobantes').select('id')
      .eq('contact_id', contactId).eq('estado', 'verificado').limit(1),
    supabaseAdmin.from('comprobantes').select('id')
      .eq('contact_id', contactId).eq('estado', 'verificado').gte('created_at', monthStart).limit(1),
  ]);

  const contact = contactRes.data;
  if (!contact || contact.blocked) return;

  const hasEver  = !!(everRes.data && everRes.data.length);
  const hasMonth = !!(monthRes.data && monthRes.data.length);

  const target = targetStatusFor(contact.status as string | null, hasMonth, hasEver);
  if (!target) return;

  await supabaseAdmin.from('contacts').update({ status: target }).eq('id', contactId);
}
