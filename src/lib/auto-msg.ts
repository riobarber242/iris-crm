// Notificación automática "recarga confirmada" — keys de settings, template por
// defecto y render de la variable. Compartido por el endpoint de configuración y
// el flujo de verificación de comprobantes para no duplicar el texto.

export const AUTO_MSG_FLAG_KEY     = 'auto_verificacion_msg';      // 'true' | 'false'
export const AUTO_MSG_TEMPLATE_KEY = 'auto_verificacion_template'; // texto con $monto

// Default = el mensaje histórico (reproduce exactamente el comportamiento previo).
export const AUTO_MSG_DEFAULT_TEMPLATE = 'Tu recarga de $monto fue confirmada ✅ ¡Ya podés jugar!';

// Tope de longitud para el template editable (defensa simple; WhatsApp soporta
// bastante más, pero no queremos textos absurdos).
export const AUTO_MSG_MAX_LEN = 1000;

// Reemplaza la variable `$monto` por el importe formateado CON signo (ej. $15.000).
// `montoFmt` es el número ya formateado (sin el signo), ej. '15.000'.
export function renderAutoMsg(template: string, montoFmt: string): string {
  return template.split('$monto').join('$' + montoFmt);
}
