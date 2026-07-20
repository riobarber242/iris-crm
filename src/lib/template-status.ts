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

export function templateStatus(approvalStatus: string | null | undefined): TemplateStatusView {
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
    default:
      // Sin sincronizar: son las plantillas legacy, que se venían usando sin problema.
      // No las bloqueamos — bloquear por "no sé" rompería campañas que hoy funcionan.
      return { color: '#bbb', label: 'Estado sin sincronizar con Meta', usable: true };
  }
}
