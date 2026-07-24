// Auto-enganche al click de botón de plantilla de campaña — núcleo PURO (sin
// acceso a DB ni a red), para poder importarlo desde el componente cliente del
// panel, la ruta de API y el runner del webhook sin arrastrar dependencias de
// servidor.
//
// Asociación botón → intención: por POSICIÓN, nunca por el texto del botón. El
// payload que manda Meta al click es `btn_${index}`, y ese índice lo asigna IRIS
// por posición al enviar la plantilla (src/lib/meta/client.ts), así que es 100%
// confiable sin depender de lo que escriba cada cliente en el botón.

export const DEFAULT_POSITIVE =
  '¡Qué bueno que te interese! 🙌 Contame por acá qué estás buscando y lo arrancamos ahora mismo. Te leo 👇';

export const DEFAULT_NEGATIVE =
  '¡Gracias por tomarte el momento de responder! 🙌 Si más adelante te copa, acá estamos. ¿Querés que te avise cuando salga una promo nueva? Escribime por acá cuando quieras 👇';

// Meta permite hasta 3 botones de respuesta rápida por plantilla.
export const MAX_BUTTONS = 3;

export type AutoReplyEntry = {
  // Texto libre a enviar al instante del click. Vacío = usar el default (solo para
  // el primer y el último botón; ver resolveAutoReply).
  text?: string;
  // Nombre de una plantilla aprobada a disparar si el texto libre falla por ventana
  // cerrada (131047). null/'' = sin fallback.
  fallback_template?: string | null;
};

export type AutoReplyConfig = {
  enabled: boolean;
  messages: AutoReplyEntry[];
};

// Convierte el payload del webhook ('btn_0', 'btn_1', …) en el índice numérico del
// botón. Devuelve null si no matchea el formato.
export function parseButtonIndex(payload: string | null | undefined): number | null {
  const m = /^btn_(\d+)$/.exec(String(payload ?? ''));
  return m ? Number(m[1]) : null;
}

// Resuelve qué mensaje auto-responder para el botón clickeado.
//  · buttonIndex: índice del botón clickeado (0 = primero).
//  · buttonCount: cantidad total de botones de la plantilla (para saber cuál es el
//    "último" = negativo). 0/desconocido → solo aplica el default del primero.
// Devuelve null si no hay nada que enviar (switch off, o posición intermedia sin
// texto configurado).
export function resolveAutoReply(
  config: AutoReplyConfig | null | undefined,
  buttonIndex: number,
  buttonCount: number,
): { text: string; fallbackTemplate: string | null } | null {
  if (!config?.enabled) return null;

  const entry = Array.isArray(config.messages) ? config.messages[buttonIndex] : undefined;
  let text = (entry?.text ?? '').trim();

  if (!text) {
    // Defaults: el PRIMER botón es el positivo; el ÚLTIMO, el negativo. Las
    // posiciones intermedias (plantillas de 3+ botones) no tienen default: solo se
    // responden si el tenant cargó un texto.
    if (buttonIndex === 0) text = DEFAULT_POSITIVE;
    else if (buttonCount >= 2 && buttonIndex === buttonCount - 1) text = DEFAULT_NEGATIVE;
  }

  if (!text) return null;

  const fallbackTemplate = (entry?.fallback_template ?? '').trim() || null;
  return { text, fallbackTemplate };
}

// Normaliza la lista de mensajes que llega del panel antes de persistirla.
export function normalizeMessages(raw: unknown): AutoReplyEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_BUTTONS).map((m: any) => ({
    text: String(m?.text ?? '').slice(0, 4000),
    fallback_template: String(m?.fallback_template ?? '').trim() || null,
  }));
}
