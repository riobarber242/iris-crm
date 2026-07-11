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
    titulo: 'Top Clientes (ranking por cargas)',
    contenido: `Muestra el "Ranking de clientes" ordenado SOLO por sus cargas verificadas (total cargado); los pagos se muestran pero no afectan el orden. Solo aparecen clientes con al menos una carga en el período. Filtros (panel colapsable arriba): Período (hoy, semana, mes, etc.), Rango de monto cargado (Mínimo y Máximo en $) y Ordenar por (monto cargado o cantidad de cargas).

Columnas: Usuario, Teléfono, Estado, Cargas (monto + cantidad) y Pagos (monto + cantidad). Sirve para detectar a los mejores clientes y armar acciones para cuidarlos (beneficios, atención prioritaria).`,
  },

  campanas: {
    titulo: 'Campañas (mensajes masivos)',
    contenido: `Crear: botón "+ Nueva campaña". El wizard tiene 4 pasos:

PASO 1 — PLANTILLA: Elegí "✏️ Texto libre" (solo llega a contactos que escribieron en las últimas 24 hs, regla de WhatsApp) o "📋 Template Meta" (llega a cualquier contacto, requiere plantilla aprobada en Meta Business Manager). Las plantillas se configuran en "Configuración → Plantillas de WhatsApp".

PASO 2 — DESTINATARIOS: Filtrá por tipo (Todos, Cliente activo, Inactivo, Inactivo sin recargar N días, Nuevo) y por línea de WhatsApp. El campo de inactividad acepta de 1 a 365 días (default 30). Tildá "Excluir contactos de campañas anteriores" para no repetir destinatarios. Abajo del filtro ves el conteo estimado en tiempo real.

PASO 3 — CONFIGURACIÓN: Ajustá los intervalos entre mensajes (mínimo y máximo en segundos) y las pausas automáticas (cada cuántos mensajes pausar y cuántos segundos). Para números nuevos (menos de 30 días): intervalos 45-90 seg, pausas cada 20 mensajes. Para números consolidados: intervalos 20-60 seg, pausas cada 50 mensajes.

PASO 4 — CONFIRMAR: Revisá el resumen y enviá. Acá también podés activar el "Cronograma escalonado por semanas" (calentamiento automático: un límite de mensajes por día distinto para cada semana calendario, ej. semana 1-2 a 20/día, semana 3 a 30, semana 4 a 50; pasada la última semana sigue a ese valor hasta terminar todos los contactos) y la ventana horaria de envío por día (de tal hora a tal hora, incluso hasta la medianoche exacta con 00:00). La campaña se pausa y retoma sola respetando el cronograma y el límite real de Meta. Una vez confirmado no se puede deshacer.

Para templates: el nombre debe coincidir EXACTO con el de Meta Business Manager, más idioma y variables {{1}}, {{2}}… El botón "+ {{nombre}}" personaliza con el nombre de cada contacto. El botón "♻️ Reactivación" precarga una campaña típica con filtro de 30 días.

HISTORIAL: Colapsable abajo de la pantalla. Filtros de 7 días / 15 días / 1 mes / 3 meses / 1 año. Por cada campaña ves: fecha, tipo, template, enviados, entregados, leídos, respuestas (btn1/btn2) y fallidos. Si hay muchos fallidos, bajá la velocidad en la próxima campaña.

CALENTAMIENTO DE NÚMEROS: Un número nuevo o sin uso por +15 días necesita calentamiento. Lo más fácil es activar el "Cronograma escalonado" en el paso 4 y dejar que el volumen suba solo, semana a semana (ej. 20/día → 30 → 50): la campaña se pausa y retoma sola cada día sin que toques nada. Saltear el calentamiento puede resultar en baneo del número.`,
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
    titulo: 'Mi Bot (control del bot, prompt y modo offline)',
    contenido: `Sección "Control del bot": prendé o pausá el bot automático que responde a tus clientes por WhatsApp (también está el toggle rápido en la barra superior).

Sección "System Prompt de tu Bot": el texto que define la personalidad y reglas del bot automático. Editá el texto y tocá "Guardar cambios" (máximo 4000 caracteres; el contador está abajo a la derecha). "Restaurar por defecto" vuelve al prompt original. TIP: también podés pedirme a mí los cambios en palabras simples ("quiero un bot más amable que derive a humano si se enojan") — te propongo el texto, lo revisás y recién con tu confirmación lo aplico.

Sección "Modo offline": cuando lo activás, el bot deja de atender y responde a todos los clientes con un único mensaje fijo de cierre (también está el toggle rápido en la barra superior). Los números de WhatsApp y las plantillas se administran en Configuración, no acá.`,
  },

  configuracion: {
    titulo: 'Configuración (ajustes de la cuenta)',
    contenido: `Secciones de la página (admin y agente): "Notificación de recarga verificada" (mensaje que se manda al cliente al verificar una recarga, editable con la variable $monto); "Clasificación de contactos" (fuerza la actualización de estados sin esperar el cron diario); "Respuestas rápidas" (plantillas de mensajes que el equipo usa desde el chat con el botón ⚡: crear, editar y borrar); "Números de WhatsApp" (las líneas conectadas al panel); "Plantillas de WhatsApp" (plantillas para campañas Template Meta).

"Números de WhatsApp": "+ Agregar número" pide Label (ej: "Línea 2"), el Phone number ID de Meta, y opcionalmente un access token propio y el WABA ID (vacíos = usan los globales). Por cada línea: "Verificar" (consulta a Meta y muestra el número real ✅ o el error), "Editar" (label/token/WABA), "Hacer default" (solo una línea puede ser default) y Activar/Desactivar. No se puede desactivar la línea default ni la única activa. Cada conversación responde por el último número al que escribió el cliente.

"Plantillas de WhatsApp": mensajes predefinidos para campañas Template Meta. "+ Agregar plantilla" (nombre, idioma, cuerpo con variables {{1}}, botones opcionales) y "Enviar a Meta" para mandarla a aprobación. El control del bot y el modo offline NO están acá: se manejan en "Mi Bot".`,
  },

  notificaciones: {
    titulo: 'Notificaciones (instalar la app y activarlas)',
    contenido: `Sirven para enterarte al instante cuando entra un mensaje de un cliente. Para activarlas: iniciá sesión en el panel y, cuando aparece abajo el cartel "🔔 Activá las notificaciones", tocá "Activar" y luego "Permitir" en el pedido del navegador. Conviene tener la app instalada (ver abajo según tu teléfono). Si falla, el propio cartel te dice la causa concreta (no un error genérico) y ese intento queda registrado para soporte.

ANDROID + CHROME: para instalar la app, abrí el panel en Chrome, tocá el menú ⋮ arriba a la derecha y elegí "Instalar app" (o "Agregar a la pantalla principal"); después abrí IRIS desde ese ícono, no desde la pestaña. Activá las notificaciones desde el cartel. Si no llegan, revisá: permiso de notificaciones de Chrome en Ajustes de Android; optimización de batería (dejá Chrome/IRIS "sin restricción", si el sistema lo duerme no llegan); datos en segundo plano permitidos; y que no haya un DNS privado o VPN bloqueando los servidores de Google.

ANDROID + SAMSUNG INTERNET: para instalar, abrí el panel en Samsung Internet, tocá el menú ☰ (abajo a la derecha) y elegí "Agregar página a → Pantalla de inicio"; abrí IRIS desde el ícono. El bloqueo más común en Samsung es el ahorro de energía: en Ajustes → Batería y cuidado del dispositivo → Batería → Límites de uso en segundo plano, asegurate de que IRIS y Samsung Internet NO estén en "Apps en suspensión" ni "suspensión profunda", y dejalos "Sin restricciones". Además revisá el permiso de notificaciones del sitio (Samsung Internet → Ajustes → Sitios web → Notificaciones) y que Google Play Services esté actualizado (las push pasan por Google).

iPHONE / iPAD (iOS + SAFARI): en iOS las notificaciones SOLO funcionan si la app está instalada en la pantalla de inicio (nunca en una pestaña normal de Safari) y con iOS 16.4 o superior. Instalala así: abrí el panel en Safari, tocá el botón Compartir (el cuadrito con la flecha hacia arriba), deslizá y tocá "Agregar a inicio", confirmá con "Agregar". Después abrí IRIS desde ese ícono y recién ahí activá las notificaciones desde el cartel. Si el permiso quedó denegado, activalo en Ajustes de iOS → Notificaciones → IRIS.

SEGÚN EL MENSAJE DE ERROR que veas al activar: "Las notificaciones están bloqueadas" = rechazaste el permiso antes, activalo en los ajustes del navegador y recargá; "No se pudo conectar con el servicio de notificaciones de Google" = suele ser Google Play Services, el ahorro de batería, un DNS privado o una VPN en ese teléfono (revisá la sección de tu equipo); "El navegador tardó demasiado" = conexión inestable, reintentá; "Había una suscripción anterior incompatible" = tocá Reintentar, se limpia sola; "La clave del servidor está mal configurada" = es del servidor, avisá al soporte de IRIS (no es tu teléfono). Aclaración honesta: la tecnología de notificaciones web no garantiza el 100% en todos los modelos (depende de Google/Apple y del manejo de batería de cada fabricante), pero con el mensaje de causa concreta cualquier fallo se identifica rápido.`,
  },
};

export type HelpFlags = { top_clientes?: boolean; campanas?: boolean };

// Secciones visibles según el rol (espejo del sidebar real en AdminShell +
// middleware). Operador: base reducida + extras solo con permiso explícito.
export function helpSectionsForRole(role: string, flags: HelpFlags = {}): string[] {
  if (role === 'operator') {
    const base = ['conversaciones', 'contactos', 'cargas', 'pagos', 'notificaciones'];
    if (flags.top_clientes) base.push('top_clientes');
    if (flags.campanas) base.push('campanas');
    return base;
  }
  if (role === 'admin') {
    return ['dashboard', 'conversaciones', 'contactos', 'cargas', 'pagos', 'top_clientes', 'campanas', 'operadores', 'agentes', 'mi_bot', 'configuracion', 'notificaciones'];
  }
  // agente: todo menos administración global (Operadores, Agentes/tenants).
  return ['dashboard', 'conversaciones', 'contactos', 'cargas', 'pagos', 'top_clientes', 'campanas', 'mi_bot', 'configuracion', 'notificaciones'];
}
