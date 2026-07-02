# IRIS — Instalar la app y activar notificaciones

Esta guía explica, paso a paso, cómo instalar **IRIS** en el teléfono y activar las
**notificaciones** para enterarte al instante cuando entra un mensaje de un cliente.

> **Importante (leé esto primero):** las notificaciones en la web dependen de un
> servicio de Google/Apple y del sistema de tu teléfono. Funciona en la gran
> mayoría de los equipos, pero **ningún sistema web garantiza el 100%** en todos
> los modelos (es una limitación de la tecnología, no de IRIS). Si en tu teléfono
> no llegan, la app ahora te muestra **el motivo concreto** al intentar activarlas
> — seguí el mensaje o mandáselo al soporte y se resuelve rápido.

Al tocar **"Activar"** IRIS te dice qué pasó. Si falla, vas a ver un mensaje como
uno de estos, con su causa:

| Mensaje que ves | Qué significa | Qué hacer |
|---|---|---|
| "Las notificaciones están bloqueadas…" | Rechazaste el permiso antes | Activá el permiso en los ajustes del navegador y recargá |
| "No se pudo conectar con el servicio de notificaciones de Google…" | Google Play Services / batería / DNS privado / VPN | Ver la sección de tu teléfono más abajo |
| "El navegador tardó demasiado en responder…" | Conexión lenta o inestable | Revisá internet y reintentá |
| "Había una suscripción anterior incompatible…" | Quedó una suscripción vieja | Tocá **Reintentar** (se limpia sola) |
| "La clave de notificaciones del servidor está mal configurada…" | Config del servidor | Avisá al soporte de IRIS (no es tu teléfono) |

---

## (a) Android con Google Chrome

### Instalar la app
1. Abrí **irisonline.app** en **Chrome**.
2. Tocá el menú **⋮** (arriba a la derecha).
3. Elegí **"Instalar app"** o **"Agregar a la pantalla principal"**.
4. Confirmá. IRIS queda como un ícono más, como cualquier app.
5. Abrí IRIS **desde ese ícono** (no desde la pestaña del navegador).

### Activar notificaciones
1. Iniciá sesión en IRIS.
2. Abajo va a aparecer el cartel **"🔔 Activá las notificaciones"** → tocá **Activar**.
3. Cuando Android pida permiso, tocá **Permitir**.
4. Listo: el cartel desaparece y quedás suscripto.

### Qué puede bloquearlo en Android/Chrome
- **Permiso de notificaciones denegado:** Ajustes → Aplicaciones → Chrome (o IRIS) → Notificaciones → activar.
- **Optimización de batería:** Ajustes → Batería → dejar IRIS/Chrome **sin restricción** (si el sistema lo "duerme", no llegan las push).
- **Datos en segundo plano restringidos:** Ajustes → Apps → IRIS/Chrome → Datos móviles → permitir uso en segundo plano.
- **No molestar / Modo concentración:** puede silenciar las notificaciones aunque lleguen.
- **DNS privado o VPN:** algunos bloquean los servidores de Google (FCM). Probá desactivándolos para confirmar.

---

## (b) Android con Samsung Internet

> Samsung Internet **sí** soporta notificaciones, pero los equipos Samsung tienen
> ajustes de ahorro de energía **más agresivos** que suelen ser la causa #1 de que
> no lleguen. Prestá atención a la sección de bloqueos.

### Instalar la app
1. Abrí **irisonline.app** en **Samsung Internet**.
2. Tocá el menú **☰** (tres líneas, abajo a la derecha).
3. Elegí **"Agregar página a"** → **"Pantalla de inicio"** (o **"Instalar"** si aparece).
4. Confirmá. Abrí IRIS **desde el ícono** de la pantalla de inicio.

### Activar notificaciones
1. Iniciá sesión.
2. Tocá **Activar** en el cartel de notificaciones.
3. Tocá **Permitir** cuando lo pida.

### Qué puede bloquearlo en Samsung (revisar en orden)
1. **Apps en suspensión / suspensión profunda (el culpable más común):**
   Ajustes → **Batería y cuidado del dispositivo** → **Batería** → **Límites de uso en segundo plano** →
   asegurate de que **IRIS y Samsung Internet NO estén** en "Apps en suspensión" ni "Apps en suspensión profunda".
2. **Optimización de batería:** en esa misma pantalla, dejá IRIS/Samsung Internet como **"Sin restricciones"**.
3. **Permiso de notificaciones del sitio:** Samsung Internet → ☰ → Ajustes → **Sitios web** → **Notificaciones** → permitir irisonline.app.
4. **Permiso de notificaciones del navegador:** Ajustes de Android → Aplicaciones → Samsung Internet → Notificaciones → activar.
5. **Google Play Services:** las push pasan por Google. Si el teléfono lo tiene deshabilitado o desactualizado (o es un equipo sin servicios de Google), no funcionan → actualizá Play Services desde la Play Store.
6. **DNS privado / VPN:** desactivá para probar (pueden bloquear FCM).

---

## (c) iPhone / iPad (iOS) con Safari

> **Confirmado:** en iOS las notificaciones web **solo funcionan si la app está
> instalada en la pantalla de inicio** — nunca en una pestaña normal de Safari. Y
> requiere **iOS 16.4 o superior**. Si abrís IRIS en una pestaña, ni siquiera
> aparece la opción de activar notificaciones (la app te va a pedir que la
> instales primero).

### Instalar la app (obligatorio para notificaciones)
1. Abrí **irisonline.app** en **Safari** (tiene que ser Safari, no Chrome en iOS).
2. Tocá el botón **Compartir** (el cuadradito con la flecha hacia arriba, abajo al centro).
3. Deslizá y tocá **"Agregar a inicio"** (Add to Home Screen).
4. Tocá **Agregar** (arriba a la derecha).
5. Cerrá Safari y abrí IRIS **desde el nuevo ícono** en la pantalla de inicio.

### Activar notificaciones
1. Abrí IRIS **desde el ícono instalado** (verás la app sin la barra de Safari).
2. Iniciá sesión.
3. Tocá **Activar** en el cartel de notificaciones.
4. Tocá **Permitir** cuando iOS lo pida.

### Qué puede bloquearlo en iOS
- **No instalaste la PWA:** si abrís desde Safari en pestaña, no hay push. Reinstalá desde "Agregar a inicio".
- **iOS viejo:** por debajo de 16.4 no hay Web Push. Actualizá iOS.
- **Permiso denegado:** Ajustes de iOS → Notificaciones → IRIS → activar "Permitir notificaciones".
- **Concentración / No molestar:** puede ocultar las notificaciones.
- **Reinstalar:** si borrás el ícono y lo volvés a agregar, hay que activar el permiso de nuevo.

---

## Cómo saber por qué falló (para el soporte de IRIS)

Cuando un cliente no logra activar las notificaciones:

1. Pedile que toque **Activar** y te **lea el mensaje** que aparece (ahora dice la causa concreta).
2. Ese mismo intento queda **registrado del lado de IRIS** con el detalle técnico
   (tipo de error, navegador, permiso, etc.), así que desde el panel se puede ver
   qué pasó **sin** necesitar que el cliente mire la consola del navegador.
3. Con ese dato, el soporte identifica en minutos si es batería, Play Services,
   permiso, red, o config — en vez de probar a ciegas.

---

## Expectativa realista

- Las notificaciones web funcionan en la **enorme mayoría** de teléfonos modernos.
- **No hay forma de garantizar el 100%** en todos los modelos: depende de Google
  (FCM), de Apple, y sobre todo del manejo de batería/energía de cada fabricante
  (Samsung, Xiaomi, Huawei, etc. son los más restrictivos). Esto es igual para
  **cualquier** app web, no es algo propio de IRIS.
- La app nativa (si algún día se hace) tendría mejor tasa de entrega, pero también
  depende de los mismos servicios de Google/Apple.
- La buena noticia: con el diagnóstico integrado, **cualquier fallo se identifica y
  se resuelve rápido**, con una causa concreta en la mano.
