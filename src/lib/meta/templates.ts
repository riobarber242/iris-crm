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

export const TEMPLATES: WhatsAppTemplateDef[] = [
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
