// Traducción de los códigos de error de Meta a algo que un operador pueda leer y
// accionar. El código y el texto original vienen del webhook de status
// (errors:[{ code, title, error_data:{ details } }]) y se guardan en
// messages.error_* / campaign_message_status.error_*.
//
// La idea NO es cubrir el catálogo entero de Meta, sino los que se ven en la
// operación diaria. Para cualquier otro caemos al texto que mandó Meta, que
// siempre es mejor que no mostrar nada.

const CODIGOS: Record<number, string> = {
  // Ventana de servicio / sesión
  131047: 'Pasaron más de 24 h desde el último mensaje del cliente. Para retomar hay que mandarle una plantilla.',
  131051: 'Tipo de mensaje no soportado por WhatsApp.',

  // Destinatario
  131026: 'El número no puede recibir mensajes: puede no tener WhatsApp, estar mal escrito o haber cambiado.',
  131052: 'No se pudo acceder al archivo adjunto.',

  // Límites y calidad
  130429: 'Se superó el límite de envíos por segundo. Reintentá en unos minutos.',
  131048: 'Meta frenó el envío por tasa de spam: la calidad del número está comprometida.',
  131049: 'Meta no entregó el mensaje para cuidar la experiencia del usuario (límite de marketing por persona).',
  130472: 'El número es parte de un experimento de Meta y no recibe este tipo de mensaje.',
  131056: 'Demasiados mensajes a este mismo número en poco tiempo.',

  // Plantillas
  132000: 'La plantilla no coincide: la cantidad de variables no es la esperada.',
  132001: 'La plantilla no existe o no está aprobada en la cuenta de WhatsApp (WABA) de esta línea.',
  132005: 'El texto traducido de la plantilla es demasiado largo.',
  132007: 'El contenido de la plantilla viola las políticas de Meta.',
  132012: 'El formato de una variable de la plantilla es inválido.',
  132015: 'La plantilla está pausada por baja calidad.',
  132016: 'La plantilla fue deshabilitada por baja calidad.',

  // Cuenta
  // 130497 visto en producción el 21/07/2026 (derqui17star): la cuenta tenía
  // restringido el envío a Brasil, y fallaba SOLO el único destinatario con
  // número +55 mientras el resto recibía normal. Es una restricción de la
  // cuenta por país: no se arregla reintentando ni cambiando el mensaje.
  130497: 'Meta restringe el envío a este país desde esta cuenta. No es un problema del mensaje: hay que habilitar el país en la cuenta de WhatsApp Business.',
  368:    'La cuenta está temporalmente bloqueada por violar las políticas de Meta.',
  131031: 'La cuenta de WhatsApp fue restringida o dada de baja.',
};

// Motivo legible de un envío fallido. Devuelve null si no hay nada que mostrar
// (mensajes fallidos anteriores a la migración, que no tienen error guardado).
export function motivoDeFallo(
  code: number | null | undefined,
  title: string | null | undefined,
  message: string | null | undefined,
): string | null {
  const conocido = code != null ? CODIGOS[code] : undefined;
  if (conocido) return conocido;

  // Sin traducción propia: el texto de Meta (details suele ser el más explicativo).
  const propio = (message ?? '').trim() || (title ?? '').trim();
  if (propio) return code != null ? `${propio} (código ${code})` : propio;

  return code != null ? `Meta rechazó el envío (código ${code}).` : null;
}
