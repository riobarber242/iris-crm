# PWA: notificaciones inconsistentes en WiFi vs datos móviles

Investigación (jul 2026) sobre por qué la PWA instalada desde Chrome a veces
tarda o no recibe notificaciones en WiFi pero sí con datos móviles (o al revés).

## Conclusión corta

**La inconsistencia WiFi vs datos es de FCM + sistema operativo + red, NO del
código de IRIS.** Es la misma categoría que el problema del sonido de
notificaciones: una limitación de la plataforma que el código no puede forzar.
Se hizo UN arreglo de código real (robustez), que NO es la causa de fondo pero
mejora la confiabilidad general. Ver abajo.

## Cómo funciona el push (contexto)

Web Push en Android/Chrome NO viaja por la red de la app: viaja por **FCM**
(Firebase Cloud Messaging). El camino es:

1. Servidor IRIS (`web-push`) → endpoint de FCM (Google).
2. FCM → dispositivo, por una **conexión persistente** que mantiene Google Play
   Services (puertos 5228–5230).

El servidor NO "empuja" al teléfono: solo le entrega el mensaje a FCM, y FCM lo
entrega cuando puede por esa conexión persistente.

## Por qué WiFi vs datos cambia el resultado

La confiabilidad/latencia depende de que la **conexión persistente de FCM** esté
viva, y eso varía por red y por SO:

- **Routers/WiFi**: muchos routers hogareños cortan conexiones TCP ociosas (NAT
  timeout) o throttlean/bloquean los puertos de FCM. Cuando eso pasa, el socket
  de FCM muere en silencio y los push quedan **encolados** hasta que la conexión
  se re-establece (al prender la pantalla o abrir la app) → "llegan todas juntas
  tarde".
- **Datos móviles**: la portadora suele mantener la conexión más viva (o a veces
  peor — por eso el síntoma es "a veces WiFi, a veces datos").
- **Android Doze / optimización de batería**: con pantalla apagada e inactivo
  (más agresivo en WiFi), el SO agrupa el acceso a red. Samsung/Xiaomi suspenden
  apps de forma especialmente agresiva.

Nada de esto es configurable desde el servicio worker ni desde el servidor.

## Lo que el código YA hace bien (no hay bug acá)

- `urgency: 'high'` en los push de conversación (`src/lib/push.ts`): le pide a FCM
  que **despierte** el dispositivo aunque esté en Doze. Es la mitigación correcta,
  pero no puede vencer un socket de FCM caído por el router.
- **Sin TTL bajo**: `web-push` usa el default (~4 semanas), así que FCM **encola**
  el mensaje cuando el dispositivo está inalcanzable en vez de descartarlo. Por eso
  el síntoma es "tarda", no "se pierde".
- Limpieza de suscripciones muertas (404/410) en `sendToSubscription`.

## Arreglo de código hecho (robustez, NO la causa WiFi/datos)

El Service Worker no tenía handler `pushsubscriptionchange`. Cuando Chrome/FCM
**rota** la suscripción (por idle largo, cambios de red o updates del navegador),
la suscripción vieja quedaba muerta y las notificaciones se cortaban en silencio
**hasta reabrir la PWA**. Se agregó el handler en `public/sw.js`: re-suscribe con
la misma VAPID key y avisa a `/api/push/subscribe` (que toma el agente de la
sesión). Best-effort; si falla, la apertura de la app lo recupera igual.

Esto reduce cortes de notificación tras rotaciones de suscripción, pero **no**
cambia la latencia WiFi vs datos, que es de FCM/SO.

## Qué se puede hacer a nivel usuario (no es código)

- Desactivar la optimización de batería para Chrome / la PWA en el teléfono.
- En algunos routers, evitar el "ahorro de energía" del WiFi o cortar el NAT
  timeout agresivo (poco práctico para clientes).
- Aceptar que, con la pantalla apagada en ciertas WiFi, los push pueden agruparse
  y llegar al prender la pantalla — es comportamiento esperado de FCM/Android.

## Veredicto

No hay un fix de código que garantice paridad WiFi/datos: es infraestructura de
FCM + comportamiento del SO. Se documenta como tal (igual que el sonido) y se dejó
la mejora de robustez del `pushsubscriptionchange`.
