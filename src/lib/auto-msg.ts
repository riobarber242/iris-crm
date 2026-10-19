// Notificación automática "recarga confirmada" — keys de settings, template por
// defecto y render de la variable. Compartido por el endpoint de configuración y
// el flujo de verificación de comprobantes para no duplicar el texto.

export const AUTO_MSG_FLAG_KEY     = 'auto_verificacion_msg';      // 'true' | 'false'
export const AUTO_MSG_TEMPLATE_KEY = 'auto_verificacion_template'; // texto con $monto (y opcional $bono)

// Default = el mensaje histórico (reproduce exactamente el comportamiento previo).
export const AUTO_MSG_DEFAULT_TEMPLATE = 'Tu recarga de $monto fue confirmada ✅ ¡Ya podés jugar!';

// Tope de longitud para el template editable (defensa simple; WhatsApp soporta
// bastante más, pero no queremos textos absurdos).
export const AUTO_MSG_MAX_LEN = 1000;

// Reemplaza `$monto` por el importe formateado CON signo (ej. $15.000) y `$bono`
// por " + $X de regalo 🎁" (vacío si no hay bono). Si el template no usa `$bono`
// y hay bono, el texto se agrega al final (comportamiento histórico, así no cambia
// nada para quien no editó su mensaje). `montoFmt` es el número ya formateado
// (sin el signo), ej. '15.000'; `bono` es el importe crudo (0/undefined = sin bono).
export function renderAutoMsg(template: string, montoFmt: string, bono?: number): string {
  const bonoNum = Number(bono) || 0;
  const bonoTxt = bonoNum > 0 ? ` + $${bonoNum.toLocaleString('es-AR')} de regalo 🎁` : '';
  let msg = template.split('$monto').join('$' + montoFmt);
  if (msg.includes('$bono')) msg = msg.split('$bono').join(bonoTxt);
  else msg += bonoTxt;
  return msg;
}
