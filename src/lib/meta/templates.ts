// Configuración de plantillas de WhatsApp (Meta) disponibles para envío manual
// desde el chat cuando se cae la ventana de 24h. Es data pura (sin imports de
// servidor) para poder importarla tanto en el cliente (modal) como en la API.

export type WhatsAppTemplateVar = 'nombre';

export type WhatsAppTemplateDef = {
  name:      string;                // nombre registrado en Meta
  language:  string;                // ej. 'es_AR'
  category:  'MARKETING' | 'UTILITY' | 'AUTHENTICATION';
  bodyText:  string;                // texto con placeholders {{1}}, {{2}}…
  variables: WhatsAppTemplateVar[]; // cómo resolver cada placeholder en orden
  phoneId?:  string;                // número dedicado opcional para enviar
};

// NOTA: para las plantillas YA aprobadas en Meta (reactivacion_*), `bodyText` es
// solo el texto de preview del modal — el envío usa la versión aprobada en Meta
// (sendWhatsAppTemplate manda name+language+vars). Todas resuelven {{1}} = nombre.
export const TEMPLATES: WhatsAppTemplateDef[] = [
  {
    name:      'reactivacion_inactivos',
    language:  'es_AR',
    category:  'MARKETING',
    bodyText:  'Hola {{1}} 🎁 Soy Iris. Hace un tiempo que no te vemos por acá — recargá este mes y te sumamos un 20% extra. ¿Arrancamos? Respondé y te atendemos enseguida 🙌',
    variables: ['nombre'],
  },
  {
    name:      'reactivacion_15',
    language:  'es_AR',
    category:  'MARKETING',
    bodyText:  'Hola {{1}} 🎁 Soy Iris. Te extrañamos — recargá este mes y te regalamos un 15% extra. ¿Te sumás? Respondé y te atendemos enseguida 🙌',
    variables: ['nombre'],
  },
  {
    name:      'reactivacion_25',
    language:  'es_AR',
    category:  'MARKETING',
    bodyText:  'Hola {{1}} 😊 Soy Iris. Hace rato que no sabemos nada de vos — recargá este mes y te sumamos un 25% extra. ¿Arrancamos? Escribinos y te atendemos ya 👊',
    variables: ['nombre'],
  },
  {
    name:      'reactivacion_30',
    language:  'es_AR',
    category:  'MARKETING',
    bodyText:  'Hola {{1}} 🎁 Soy Iris. Te tenemos una sorpresa — recargá este mes y te damos un 30% extra. Es nuestra mejor oferta. ¿Va? Respondé y te atendemos enseguida 🍺',
    variables: ['nombre'],
  },
  {
    name:      'bienvenida_reactivacion',
    language:  'es_AR',
    category:  'MARKETING',
    bodyText:  'Hola {{1}}! Soy Iris 👋 Ya estamos activos nuevamente. Disculpá la demora. Estamos acá para ayudarte con lo que necesites. 🙌',
    variables: ['nombre'],
  },
];

export function getTemplate(name: string): WhatsAppTemplateDef | undefined {
  return TEMPLATES.find((t) => t.name === name);
}

// Texto de preview con el placeholder {{1}} reemplazado (por el nombre real o un
// marcador legible cuando todavía no lo conocemos).
export function previewTemplate(def: WhatsAppTemplateDef, nombre = '[nombre]'): string {
  return def.bodyText.replace(/\{\{1\}\}/g, nombre);
}
