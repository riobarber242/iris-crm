// Base de conocimiento del panel IRIS para Iris AI (herramienta get_help).
// Cada sección describe la UI REAL (nombres de botones y pasos verificados en
// el código de cada página). Si una pantalla cambia, actualizar acá.
//
// El acceso por rol se resuelve con helpSectionsForRole(): Iris solo recibe y
// puede pedir las secciones del panel que ese usuario realmente ve.

export type HelpSection = { titulo: string; contenido: string };

export const HELP_SECTIONS: Record<string, HelpSection> = {
  conversaciones: {
    titulo: 'Conversaciones (chats de WhatsApp)',
    contenido: `La lista muestra todas las conversaciones del negocio, las más recientes arriba. Los puntos de color marcan pendientes: 🔴 rojo = cliente esperando atención humana (terminó el onboarding o ya es cliente conocido), 🟠 naranja = le respondió el bot pero falta un humano. Abrir el chat lo marca como leído y limpia el pendiente.

Para responder: escribí en el cuadro de abajo y mandá con Enter. Tu mensaje sale con tu firma abajo (ej: "jessica · operador") para que el equipo sepa quién respondió. Botón ⚡ "Respuestas rápidas": plantillas predefinidas que se cargan con un clic (se administran en Configuración). También podés mandar imágenes (clip) y audios (micrófono).

Estados del mensaje (al lado de la hora): ✓ enviado, ✓✓ gris entregado, ✓✓ azul leído, ⚠ "No entregado" en rojo = WhatsApp lo rechazó. Si un texto libre falla porque el cliente no escribió en las últimas 24 horas (regla de WhatsApp), aparece el botón "Usar plantilla" para mandarle una plantilla aprobada de Meta, que sí llega siempre.

También podés reaccionar con emojis a los mensajes del cliente (clic sobre el mensaje).`,
  },

  contactos: {
    titulo: 'Contactos (clientes agendados)',
    contenido: `La página lista los contactos agendados (los que tienen usuario de casino cargado). Buscá por nombre, usuario o teléfono en el buscador de arriba. El botón 💬 de cada fila abre su conversación.

Importar desde CSV: botón "⬆ Importar CSV". Antes de elegir el archivo configurá los dos selectores: 1) Modo: "Insertar nuevos" (default — solo agrega teléfonos que no existen, los repetidos se saltean) o "Actualizar existentes" (completa nombre, usuario y provincia VACÍOS de contactos que ya están; lo ya cargado nunca se pisa; los teléfonos nuevos se insertan igual). 2) "📱 Asignar a línea": a qué línea de WhatsApp quedan asignados los importados (default: la línea principal).

Columnas del CSV: phone (obligatoria), casino_username y name (opcionales). También se acepta el export de Google Contacts directo (usa "First Name" y "Phone 1 - Value" automáticamente). Los teléfonos se normalizan solos (+54, espacios y guiones no molestan). Al terminar, un cartel muestra el resultado: insertados, actualizados y sin cambios.`,
  },

  cargas: {
    titulo: 'Cargas (verificar recargas)',
    contenido: `Las cargas YA NO entran solas. Cada comprobante llega a esta bandeja porque alguien tocó "📤 Enviar a verificar" sobre una imagen del cliente en la conversación. Si una recarga no aparece acá, andá al chat y mandala a verificar desde ahí.

Arriba están los filtros por estado (chips: Pendientes, Verificados, Rechazados, Todos) y un buscador por usuario de casino o teléfono. Clic en la imagen del comprobante para verla en grande (clic afuera para cerrar).

Para VERIFICAR un comprobante pendiente: 1) Tocá "✓ Verificar". 2) Ingresá el monto en el campo "Monto $" — o tocá "✨ IA" para que lo detecte automáticamente de la imagen (revisalo igual). 3) Confirmá con "✓ OK" (o "Cancelar" para volver). Si la notificación automática está activada en Configuración, el cliente recibe "Tu recarga de $X fue confirmada ✅" por WhatsApp.

Para RECHAZAR: botón "✕ Rechazar" (sin monto). En verificados que quedaron sin monto aparece "✏ Editar monto" para completarlo después. Cada comprobante resuelto muestra quién lo verificó o rechazó y cuándo.

Si el comprobante es dudoso (imagen ilegible, monto que no coincide, posible duplicado): no lo verifiques — pedile al cliente por el chat una captura más clara, y ante la duda consultá con tu agente o admin antes de resolver.`,
  },

  pagos: {
    titulo: 'Pagos (verificar pagos al cliente)',
    contenido: `Bandeja hermana de Cargas, pero para los PAGOS que el equipo le hace al cliente (premios, retiros). Los pagos entran cuando alguien toca "📤 Enviar a verificar" sobre una imagen que MANDÓ el equipo en la conversación. Mismos filtros (Pendientes/Verificados/Rechazados/Todos) y buscador que Cargas.

Verificar un pago hace lo contrario que una carga: SUBE fichas al pozo y BAJA tu billetera por ese monto (sin bono). Si el monto es mayor a lo que tenés en la billetera, no se verifica: aparece "Saldo insuficiente — este pago debe manejarlo el agente". En ese caso avisale al agente/admin.

El agente/admin también puede cargar un "pago manual" (premio grande pagado por fuera): sube la imagen y el monto; al verificarlo suben las fichas al pozo pero NO baja la billetera de ningún operador.`,
  },

  top_clientes: {
    titulo: 'Top Clientes (ranking por recargas)',
    contenido: `Muestra el "Ranking de clientes" según sus recargas verificadas. Filtros (panel colapsable arriba): Período (hoy, semana, mes, etc.), Rango de monto (Mínimo y Máximo en $) y Ordenar por (monto total o cantidad de recargas).

Columnas: Usuario, Teléfono, Estado, Recargas (cantidad) y Monto total. Sirve para detectar a los mejores clientes y armar acciones para cuidarlos (beneficios, atención prioritaria).`,
  },

  campanas: {
    titulo: 'Campañas (mensajes masivos)',
    contenido: `Crear: botón "+ Nueva campaña". Completá: Nombre; Tipo de mensaje: "✏️ Texto libre" (solo llega a contactos que escribieron en las últimas 24 hs — regla de WhatsApp) o "📋 Template Meta" (llega a cualquier contacto, requiere una plantilla aprobada en Meta Business Manager); Destinatarios (Todos, Cliente activo, Inactivo, Inactivo sin recargar 30+/45+ días, Nuevo) y el selector "Línea" para apuntar a una sola línea de WhatsApp; Límite de contactos (opcional). Debajo del filtro ves el conteo estimado de destinatarios.

Para templates: el "Nombre del template" debe coincidir EXACTO con el de Meta Business Manager, más el idioma y las variables {{1}}, {{2}}… — el botón "+ {{nombre}}" hace que cada contacto reciba su propio nombre. El botón "♻️ Reactivación" precarga una campaña típica de reactivación con filtro de 30+ días.

La campaña se guarda como borrador: se manda con "Enviar campaña" (pide confirmación — no se puede deshacer) y se puede "Eliminar" mientras sea borrador. Cada contacto recibe por SU línea de WhatsApp. Abajo está el "Historial de envíos" (colapsable) con las campañas completadas: filtros rápidos de 7 días / 15 días / 1 mes / 3 meses / 1 año, y por cada una: fecha, tipo, template y destinatarios alcanzados.`,
  },

  dashboard: {
    titulo: 'Dashboard (métricas del negocio)',
    contenido: `Es la página de inicio con los widgets de métricas: Sin responder (pendientes 🔴/🟠), conversaciones, contactos nuevos, embudo por estado, recargas y montos verificados, ticket promedio, comparativa con el mes anterior, SLA de primera respuesta humana, Top Clientes y Operadores.

Personalizar: botón ⚙ "Personalizar" arriba del widget "Sin responder" — desde ahí podés arrastrar para reordenar, renombrar y ocultar/mostrar widgets. Los cambios quedan guardados para tu usuario.`,
  },

  operadores: {
    titulo: 'Operadores (gestión del equipo)',
    contenido: `Alta: completá Usuario, Nombre, Email, Contraseña, Rol (agente u operador) y, si querés, el horario de atención (informativo). Para operadores podés habilitar permisos extra con los tildes "Top Clientes" y "Campañas" — sin esos tildes, el operador solo ve Conversaciones, Contactos y Comprobantes.

En la lista podés editar cada miembro (lápiz): nombre, email, rol, horario, permisos y su system prompt personal del bot si corresponde; "Guardar" confirma. También se puede resetear la contraseña y activar/desactivar el acceso. Los operadores desactivados no pueden loguearse.`,
  },

  agentes: {
    titulo: 'Agentes (negocios/tenants)',
    contenido: `Administración de los negocios (tenants) de la plataforma: alta con nombre y credenciales de WhatsApp (phone id y access token propios del negocio, editables en línea). Cada negocio tiene sus propios contactos, conversaciones, comprobantes y configuración, completamente separados. Es administración global: usala solo si sabés lo que estás tocando.`,
  },

  mi_bot: {
    titulo: 'Mi Bot (prompt y números de WhatsApp)',
    contenido: `Sección "System Prompt de tu Bot": el texto que define la personalidad y reglas del bot automático que responde a tus clientes por WhatsApp. Editá el texto y tocá "Guardar cambios" (máximo 4000 caracteres; el contador está abajo a la derecha). "Restaurar por defecto" vuelve al prompt original. TIP: también podés pedirme a mí los cambios en palabras simples ("quiero un bot más amable que derive a humano si se enojan") — te propongo el texto, lo revisás y recién con tu confirmación lo aplico.

Sección "Números de WhatsApp" (solo admin): las líneas conectadas al panel. "+ Agregar número" pide Label (ej: "Línea 2"), el Phone number ID de Meta, y opcionalmente un access token propio y el WABA ID (vacíos = usan los globales). Por cada línea: "Verificar" (consulta a Meta y muestra el número real ✅ o el error), "Editar" (label/token/WABA), "Hacer default" (solo una línea puede ser default) y Activar/Desactivar. No se puede desactivar la línea default ni la única activa. Cada conversación responde por el último número al que escribió el cliente.`,
  },

  configuracion: {
    titulo: 'Configuración (ajustes del sistema)',
    contenido: `Secciones de la página: "Control del bot" (prender o pausar el bot automático — también está el toggle rápido en la barra superior, junto al de modo offline); "Notificación de recarga verificada" (manda automáticamente "Tu recarga de $X fue confirmada ✅" al verificar un comprobante); "Clasificación de contactos" (fuerza la actualización de estados sin esperar el cron diario); "Respuestas rápidas" (las plantillas que el equipo usa desde el chat con el botón ⚡: crear, editar y borrar); "Prompt del bot" y "Variables de sistema" (configuración interna).

El modo offline (toggle en la barra superior) hace que el bot responda a todos con el mensaje de cierre ("no estamos operando") hasta que lo desactives.`,
  },
};

export type HelpFlags = { top_clientes?: boolean; campanas?: boolean };

// Secciones visibles según el rol (espejo del sidebar real en AdminShell +
// middleware). Operador: base reducida + extras solo con permiso explícito.
export function helpSectionsForRole(role: string, flags: HelpFlags = {}): string[] {
  if (role === 'operator') {
    const base = ['conversaciones', 'contactos', 'cargas', 'pagos'];
    if (flags.top_clientes) base.push('top_clientes');
    if (flags.campanas) base.push('campanas');
    return base;
  }
  if (role === 'admin') {
    return ['dashboard', 'conversaciones', 'contactos', 'cargas', 'pagos', 'top_clientes', 'campanas', 'operadores', 'agentes', 'mi_bot', 'configuracion'];
  }
  // agente: todo menos administración global (Operadores, Agentes/tenants).
  return ['dashboard', 'conversaciones', 'contactos', 'cargas', 'pagos', 'top_clientes', 'campanas', 'mi_bot', 'configuracion'];
}
