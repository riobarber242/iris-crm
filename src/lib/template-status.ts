// Estado de aprobación de una plantilla en Meta, traducido a lo que muestra la UI.
// El approval_status lo baja /api/whatsapp-templates/sync desde la Graph API.
//
// Por qué importa: una plantilla que Meta todavía no aprobó NO se puede enviar —
// la rechaza en silencio (error 132001) y el intento se pierde sin aviso. Por eso
// el asistente de campañas solo deja elegir las que `usable` marca en true.

export type TemplateStatusView = {
  color: string;      // color del punto
  label: string;      // texto corto para el tooltip / la fila
  usable: boolean;    // ¿se puede elegir en una campaña?
};

// Corte de la migración de plantillas por WABA (commit 9a3d562, deployado el
// 2026-07-20). Las filas ANTERIORES nacieron sin approval_status porque Iris
// todavía no lo conocía, y se venían usando sin problema: a esas no las
// bloqueamos por "no sé". Una fila POSTERIOR sin estado es una plantilla nueva
// a la que el sync todavía no le bajó el veredicto de Meta (la ventana del bug
// de revinculacion_2): esa NO es usable hasta que Meta diga APPROVED.
const WABA_MIGRATION_CUTOFF = Date.parse('2026-07-21T00:00:00Z');

export function templateStatus(
  approvalStatus: string | null | undefined,
  createdAt?: string | null,
): TemplateStatusView {
  const s = String(approvalStatus ?? '').toUpperCase();

  switch (s) {
    case 'APPROVED':
      return { color: '#1a7a3a', label: 'Aprobada — lista para usar', usable: true };
    case 'PENDING':
    case 'PENDING_DELETION':
    case 'IN_APPEAL':
      return { color: '#F2994A', label: 'En revisión por Meta — todavía no se puede usar', usable: false };
    case 'REJECTED':
      return { color: '#E53935', label: 'Rechazada por Meta', usable: false };
    case 'PAUSED':
      return { color: '#E53935', label: 'Pausada por Meta (baja calidad)', usable: false };
    case 'DISABLED':
      return { color: '#E53935', label: 'Deshabilitada por Meta', usable: false };
    case 'LIMIT_EXCEEDED':
      return { color: '#E53935', label: 'Límite de plantillas de la WABA excedido en Meta', usable: false };
    case 'ARCHIVED':
      return { color: '#E53935', label: 'Archivada en Meta', usable: false };
    case 'DELETED':
      return { color: '#E53935', label: 'Eliminada en Meta', usable: false };
    default: {
      // Meta reportó un estado que no conocemos: fail-closed. Si Meta dijo algo
      // y no sabemos qué significa, no dejamos que se dispare una campaña con eso.
      if (s) return { color: '#E53935', label: `Estado desconocido de Meta (${s})`, usable: false };

      // Sin estado (nunca sincronizada). Solo las legacy pre-migración se dejan
      // usar: bloquearlas rompería campañas que hoy funcionan. Una plantilla
      // nueva sin estado queda bloqueada hasta que el sync baje el veredicto
      // (sin fecha conocida se asume nueva: fail-closed).
      const created = createdAt ? Date.parse(createdAt) : NaN;
      const esLegacy = Number.isFinite(created) && created < WABA_MIGRATION_CUTOFF;
      return esLegacy
        ? { color: '#bbb', label: 'Estado sin sincronizar con Meta', usable: true }
        : { color: '#bbb', label: 'Sin estado de Meta todavía — sincronizá y esperá la aprobación', usable: false };
    }
  }
}
