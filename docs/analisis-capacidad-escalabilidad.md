# IRIS CRM — Análisis de capacidad y escalabilidad

**Fecha:** 2026-07-04
**Alcance:** solo investigación y medición sobre datos reales de producción (proyecto Supabase `sqovutbnotcwyygsacjx`). No se tocó código.
**Objetivo:** determinar si la estructura actual está lista para escalar con más tenants/clientes de volumen alto, y hasta qué punto antes de tener que invertir en infraestructura.

---

## TL;DR (para Gonzalo)

1. **La base es chica y sana** (~37 MB, 7% del límite Free). El tamaño de datos NO es el problema por mucho tiempo.
2. **El primer muro NO es la base ni Realtime: es el EGRESS (ancho de banda de salida).** Y ya lo estás rozando **con un solo tenant activo**.
3. La causa raíz es **una pantalla, no la infraestructura**: la lista de **Conversaciones** descarga *toda* la conversación de *todos* los contactos (medido: **585 KB comprimidos por request**) y lo repite **cada 5 segundos** por agente. Eso son **~411 MB/hora por agente** con esa pestaña abierta.
4. Con el plan **Free (5 GB/mes de egress)**, eso se agota en **~12 horas-agente al mes**. Es decir: **un solo agente trabajando ~1,5 días con la pestaña de Conversaciones abierta consume todo el egress mensual del plan Free.**
5. **Conclusión honesta:** hoy **NO se puede sumar tenants de volumen** sin (a) subir a Pro **y** (b) arreglar el patrón de Conversaciones. Si arreglás solo el código (paginar Conversaciones + apoyarse en el Broadcast que ya migraste), el egress cae **50–100×** y recién ahí la estructura escala a **10–20 tenants** de este tamaño en Pro.

---

## 0. Datos reales de producción (medidos hoy)

Conteos exactos vía REST API con la service_role key (`count=exact`, sin bajar filas):

| Tabla | Filas totales | Tenant activo (Casino 17Star) | Tenant import (derqui17star) |
|---|---:|---:|---:|
| **contacts** | **55.200** | 785 | **54.415** |
| **messages** | 6.362 | 6.362 | 0 |
| **comprobantes** | 904 | 904 | 0 |
| **movimientos** | 852 | 852 | 0 |
| internal_messages | 284 | — | — |
| activity_log | 6.362 | — | — |
| leads | 0 | 0 | 0 |
| campaigns | 4 | — | — |
| campaign_recipients | 0 | — | — |
| agents | 8 | — | — |

**Tenants (3, todos en plan `trial` a nivel app):**
- `Principal` (`00000000-…-0001`) — vacío (tenant de sistema).
- **`Casino 17Star`** (`f56fdb7c…`) — **el único con actividad real**: 785 contactos, 6.362 mensajes, 904 comprobantes.
- `derqui17star` (`9f120468…`) — **54.415 contactos importados, 0 actividad** (lista de reactivación cargada, sin conversaciones).

**Volumen de mensajes (Casino 17Star):** historial retenido ~9 días (más viejo `2026-06-25`, más nuevo `2026-07-04`). Ritmo actual **~700 mensajes/día** (5.228 en los últimos 7 días, 2.562 en los últimos ~3,7 días).

> ⚠️ El "736 contactos" del bug de `unread_counts` era el conteo del tenant activo (hoy 785). Pero **la tabla `contacts` tiene 55.200 filas** por la lista importada. Cualquier query que recorra `contacts` sin filtrar bien por tenant, o que arme un `.in()` con IDs de contactos del tenant importado, opera sobre **54.415 filas**, no 785.

---

## 1. Plan de Supabase y límites reales

### Aclaración importante sobre "plan"
El campo `plan = trial` que se ve en la tabla `tenants` es **a nivel aplicación** (el estado comercial de cada cliente del CRM). **No es el plan de facturación de Supabase.** El plan de Supabase es de la organización y **solo se confirma en el dashboard de Supabase → Settings → Billing** (no es legible desde la API ni el repo). Gonzalo lo vio como **Free** hace unas semanas; el resto de este informe asume **Free** y marca explícitamente qué cambia en **Pro**.

### Límites Free vs Pro (fuente: supabase.com/pricing, verificado hoy)

| Recurso | **Free** | **Pro ($25/mes)** | Uso actual estimado |
|---|---|---|---|
| Tamaño de base de datos | **500 MB** | 8 GB incluidos | **~37 MB (7%)** ✅ |
| **Egress / ancho de banda** | **5 GB/mes** | 250 GB/mes | **crítico — ver §6** 🔴 |
| Storage de archivos (media) | **1 GB** | 100 GB | acumula (§7) 🟡 |
| MAU (usuarios Auth activos/mes) | 50.000 | 100.000 | **N/A** (§5) ✅ |
| Realtime — conexiones concurrentes | **200** | 500 | holgado (§4) ✅ |
| Realtime — mensajes/mes | **2 M** | 5 M | holgado hoy (§4) ✅ |
| Pausa por inactividad | **sí, a la semana** | nunca | riesgo operativo 🟡 |

**Nota MAU (N/A):** IRIS **no usa Supabase Auth**. El login es propio (tabla `agents` con hash scrypt, ver `supabase-schema.sql`). Los "usuarios" que Supabase contabilizaría como MAU son ~0. **El límite de 50.000 MAU no aplica.** Bien: descarta un límite de un plumazo.

**Nota pausa por inactividad:** en Free, el proyecto se **pausa tras 1 semana sin actividad**. Con tráfico real diario no se dispara, pero es un riesgo si un fin de semana largo no entra nadie (se cae el webhook de WhatsApp hasta reactivar a mano). En Pro no pasa.

---

## 2. Modelo de conexiones — el buen dato de arquitectura

**Todo el acceso a la base es vía la REST API de Supabase (PostgREST) sobre HTTP.** El cliente se crea con `createClient(url, serviceRoleKey)` en `src/lib/db.ts`; **no hay conexión directa a Postgres** (no existe `DATABASE_URL` ni librería `pg`/`postgres` en el proyecto).

**Por qué importa:** las funciones serverless de Vercel **no mantienen conexiones persistentes** a la base. Cada request es una llamada HTTP stateless a PostgREST, que gestiona internamente su propio pool contra Postgres. Esto significa que el clásico problema de "serverless agota el `max_connections` de Postgres" **acá no aplica** — no hay que preocuparse por el pooler vs conexiones directas ni por el límite de conexiones del compute Nano. El cuello de botella se corre a **CPU de Postgres + throughput de PostgREST + egress**, no a cantidad de conexiones. ✅

---

## 3. Índices (columnas más consultadas)

Revisados contra los archivos de migración aplicados (`supabase-*.sql`). Estado **bueno** en general:

| Tabla | Índices relevantes existentes | Veredicto |
|---|---|---|
| **contacts** | `(tenant_id)`, `UNIQUE(phone, tenant_id)`, `(assigned_agent_id)`, `(whatsapp_number_id)`, `(last_seen_by)` | ✅ tenant_id cubierto |
| **messages** | `(tenant_id)`, **`(contact_id, created_at)`** | ✅ el compuesto `(contact_id, created_at)` es exactamente el correcto para cargar una conversación |
| **comprobantes** | `(tenant_id)`, `(tenant_id, operador_id)`, `UNIQUE(source_message)` | ✅ |
| **movimientos** | `(tenant_id, created_at desc)`, `(tenant_id, operador_id, created_at desc)`, `(comprobante_id)` | ✅ muy bien |
| **activity_log** | `(tenant_id, created_at desc)`, `(actor_id, created_at desc)`, `(tenant_id, action, created_at desc)` | ✅ |

### Huecos menores (no urgentes hoy, sí al crecer)
- **`contacts` no tiene índice `(tenant_id, created_at)`.** La lista de Conversaciones ordena por `created_at desc` filtrando por tenant. Con 785 filas es irrelevante; si un tenant llega a decenas de miles de contactos *con actividad*, ese `ORDER BY` se apoya solo en `idx_contacts_tenant` y ordena en memoria. Recomendado agregarlo **antes** de tener tenants grandes de verdad.
- **No hay columna `last_message_at` en `contacts`.** Por eso la lista de conversaciones se ordena trayendo *todos los mensajes* y ordenando en JS (raíz del problema de egress, §6). Un `contacts.last_message_at` indexado (actualizado al insertar mensaje) eliminaría la necesidad del join gigante. Es un cambio de diseño, no solo un índice.

**Conclusión índices:** no falta ningún índice *crítico* para el volumen actual. El problema de escalabilidad **no es falta de índices**, es **el patrón de queries** (§6).

---

## 4. Realtime — consumo por usuario y con la migración de hoy

### Cuántas conexiones/canales abre cada usuario logueado
El cliente `supabase-js` abre **un (1) websocket por navegador** y multiplexa todos los canales sobre esa conexión. Para el límite de **conexiones concurrentes de Realtime (200 Free / 500 Pro)**, lo que cuenta es **el websocket ≈ 1 por pestaña de agente logueado**. Los "canales" son lógicos y viajan sobre ese único socket.

Canales lógicos que abre cada usuario (para dimensionar mensajes, no conexiones):

| Contexto | Canales abiertos | Detalle |
|---|---|---|
| Siempre (en `AdminShell`, todo el shell) | 2 (admin) / 3 (agente-operador) | `unread-badge` (postgres_changes messages+comprobantes), `messages:tenant:{id}` (**Broadcast** ✅), `internal-unread-badge` |
| + Dashboard | +1 | `realtime-dashboard` (5 listeners: contacts, comprobantes, leads, messages×2) |
| + Conversaciones (chat abierto) | +2 | `realtime-conversations` + `messages:contact:{id}` |
| + Comprobantes | +1 | `realtime-comprobantes` |
| + Chat interno | +1 | `internal:room:{id}` (postgres_changes **+** Broadcast) |

→ **Un agente típico tiene 3–5 canales lógicos abiertos sobre 1 websocket.**

### Impacto de la migración de hoy (Fase 2: Broadcast para messages/internal_messages)
- **Sí ayuda, pero parcialmente.** Con Broadcast, el server emite **una señal sin contenido** filtrada por tenant/room; el navegador re-fetchea por API. Antes, `postgres_changes` empujaba **cada fila** a **cada** cliente suscrito.
- **Lo que sigue en `postgres_changes` sin filtro de tenant:** `unread-badge` (messages+comprobantes), `realtime-dashboard` (contacts/comprobantes/leads/messages), `realtime-conversations`, `realtime-comprobantes`, `realtime-caja/fichas/mi-caja` (movimientos). Estos **escuchan la tabla entera**: un cambio de fila de **cualquier tenant** se empuja a **todos** los usuarios suscritos, y cada push dispara un re-fetch de los endpoints pesados del §6.

### ¿Se toca el límite de Realtime?
- **Conexiones concurrentes (200 Free):** ≈ 1 por agente-pestaña. Con un puñado de tenants y 3–5 agentes c/u, estás en **decenas**, no cientos. **No es el cuello de botella.** ✅
- **Mensajes Realtime/mes (2 M Free):** estimación con el volumen actual (~700 inserts/día de messages × fan-out a ~3–5 sockets conectados + eventos de comprobantes/movimientos) ≈ **3.000–5.000 msgs/día ≈ 90k–150k/mes**. **Muy por debajo de 2 M.** ✅ Pero **escala con (inserts × agentes conectados × tenants)**: con 10 tenants activos y más agentes, este número se multiplica y hay que revisarlo.

**Conclusión Realtime:** con la migración de hoy y el volumen actual, Realtime **no es limitante**. El costo real de Realtime en este diseño **no es el cupo de Supabase, sino que cada evento sin filtrar dispara las queries pesadas del §6** (efecto multiplicador de CPU + egress).

---

## 5. Multi-tenant — degradación no-lineal

**Riesgo real, concreto:** varios `postgres_changes` **no filtran por tenant** (`unread-badge`, `realtime-dashboard`, `realtime-conversations`, `realtime-comprobantes`, los de `movimientos`). En un proyecto Supabase compartido por todos los tenants, esto produce degradación **no-lineal**:

> Un INSERT de mensaje de **cualquier** tenant → se empuja a **todos** los agentes conectados (de todos los tenants) suscritos a esa tabla → **cada** agente re-ejecuta sus queries full-table (unread_counts, conversations, dashboard_stats).

Costo aproximado ∝ **(nº tenants) × (eventos/seg) × (nº agentes conectados) × (costo query full-table)**. Con 1 tenant activo es tolerable; con 5–10 tenants de volumen simultáneos, **crece cuadráticamente** (más eventos × más agentes que reaccionan a eventos ajenos).

Las **queries** en sí sí filtran por `tenant_id` (con índice), así que no hay fuga de datos entre tenants ni escaneo cruzado en la base. El problema es **la frecuencia con la que se disparan** por eventos de otros tenants.

---

## 6. Cuello de botella #1 — EGRESS por la lista de Conversaciones (medido)

Este es el hallazgo central, con números reales medidos hoy contra producción.

> ### ✅ RESUELTO — 2026-07-05 (commit `a312c86`)
> El fix está en producción. La query `.select('*, messages!inner(*)')` se reemplazó por la
> RPC `fn_conversations_list` (dos `LATERAL JOIN`, ver `supabase-conversations-list-rpc.sql`)
> que devuelve por contacto **solo el último mensaje** + `pending_count` calculado server-side,
> y el poll de respaldo pasó de **5 s a 60 s** (el Broadcast de Fase 2 + `postgres_changes` dan
> la inmediatez; el poll es solo red de seguridad).
>
> **Medido contra la función ya desplegada** (mismo tenant activo, 130 conversaciones):
>
> | Métrica | Antes | Después | Mejora |
> |---|---|---|---|
> | Payload sin comprimir | 3,32 MB | **0,10 MB** | 33× |
> | **Payload gzip (en el cable)** | **529 KB** | **12,8 KB** | **41,5×** |
> | Poll | cada 5 s | cada 60 s | 12× |
> | **Egress por agente/hora** | ~372 MB/h | **~0,74 MB/h** | **~500×** |
> | Free (5 GB/mes) se agota en | ~12 h-agente | **~6.700 h-agente** | — |
>
> `pending_count` verificado **1:1 contra la fórmula vieja** en los 130 contactos (0 diferencias),
> y el último mensaje idéntico. El badge numérico y el preview quedan sin cambios de comportamiento.
> El diagnóstico original que sigue abajo se conserva como registro del problema.

### El patrón
`src/app/api/conversations/route.ts:18`:
```ts
supabaseAdmin.from('contacts')
  .select('*, messages!inner(*)')   // TODOS los contactos + TODOS sus mensajes
  .eq('tenant_id', session.tenant_id)
  .order('created_at', { ascending: false })
```
Sin `.limit()` ni `.range()`. Trae **todos los contactos con conversación y el historial completo de cada uno**, y ordena en memoria. `src/components/ConversationsClient.tsx:88` lo **pollea cada 5 segundos** de forma incondicional (sin guarda de visibilidad de pestaña), además de re-disparar en cada evento Realtime.

### Medición real (tenant activo, 785 contactos / 6.362 mensajes)
| Métrica | Valor medido |
|---|---|
| Payload sin comprimir | **3,04 MB** por request |
| **Payload en el cable (gzip)** | **585 KB** por request |
| Frecuencia | **cada 5 s** (12 requests/min) por agente con la pestaña abierta |
| **Egress por agente/hora** | **~411 MB/hora** |
| Egress por turno de 8 h | **~3,2 GB** |
| **Free (5 GB/mes) se agota en** | **~12 horas-agente/mes** |
| Pro (250 GB/mes) se agota en | ~623 horas-agente/mes (~3,5 agentes full-time) |

> **Traducido:** un solo agente con la pantalla de Conversaciones abierta ~1,5 jornadas laborales consume **todo** el egress mensual del plan Free. Dos agentes trabajando un día normal ya lo revientan.

### Por qué empeora con el tiempo (no es estático)
El payload **crece linealmente con el historial de mensajes**, porque manda la conversación completa de cada contacto en cada poll. Hoy el historial es de ~9 días (6.362 mensajes). A 6 meses de historial (~130k mensajes) el payload se multiplica ~20× → **~12 MB gzip por request** → el egress se dispara aunque no sumes tenants. **Escala con el tiempo, no solo con clientes.**

### Otras queries full-table que agravan (mismo agente, mismos 5–15 s)
Del relevamiento de código (ver detalle en §8):
- `unread_counts/route.ts:19-34` — doble select full-table (contacts + messages del tenant), cada **15 s** + cada evento Realtime.
- `dashboard_stats/route.ts:161` — trae **toda** la tabla `messages` sin filtro de fecha para clasificar en memoria; corre al abrir Dashboard + cada evento Realtime.
- `dashboard_charts`, `comprobantes`, `leads`, varios de `iris-ai` — selects sin `.limit()` sobre tablas que solo crecen.

Todos comparten la misma patología: **traer todo y procesar en Node** en vez de agregar/paginar en Postgres.

---

## 7. Cuello de botella #2 — el `.in()` gigante silencioso

El bug de clase `.in()` gigante (supabase-js manda la lista como query-string; con >~180 UUIDs se excede el largo de URL → **HTTP 414, la query falla en silencio y devuelve 0**) es real. **Verificado en vivo:** un `.in('id', ids)` con 12.000 UUIDs devuelve `414 Request-URI Too Large` (lo corta Cloudflare antes de PostgREST); chunkeado en lotes de 200 devuelve las 12.000 filas completas.

> ### ✅ RESUELTO — 2026-07-05/06 (commit `c998713`)
> **Corrección al diagnóstico original:** este análisis apuntaba a `campaigns/reactivacion/route.ts:31`, pero esa ruta **y su componente `ReactivacionInactivos` estaban MUERTOS** — habían sido removidos de la UI en el commit `83fc01b` y no los llamaba ningún flujo vivo. El bug con el que ese `.in()` "fallaba en producción" **no podía dispararse por la app**. Además, en la práctica el tenant de 54k (`derqui17star`) tiene **0 inactivos** (están todos en `nuevo`), así que ni siquiera era latente por ahí.
>
> **El bug real y alcanzable estaba en el flujo vivo** (`/campanas` → wizard → `campaigns/send/route.ts:86`): cuando se eligen contactos a mano, `recipient_ids` iba a un solo `.in('id', ...)` con el mismo 414 silencioso. Se arregló ahí:
> - `.in('id', explicitIds)` **chunkeado en lotes de 200** + **error surfacing** (antes `const { data } = ...` se tragaba el error → "0 enviados" en silencio; ahora revierte la campaña a borrador y devuelve el error).
> - Se **borró el código muerto** (`ReactivacionInactivos` + `api/campaigns/reactivacion`).
>
> El fix del timeout del mismo flujo va en la §8.

Otros `.in()` de riesgo medio (crecen con el histórico, hoy acotados): `iris-ai listTopClients:417`, `dashboard_stats:153`. El resto de los `.in()` del repo están acotados o ya chunked a 200 (bien).

### Storage / media (contexto para egress)
El proyecto sube a Supabase Storage: media entrante de WhatsApp (`handler.ts`), comprobantes, audios, avatares, imágenes de chat interno. Hoy cabe en 1 GB, pero **cada vez que un agente abre una imagen es egress adicional** (se suma a los 5 GB). Con volumen alto de comprobantes/fotos, Storage y su egress son el **segundo** consumidor de ancho de banda después de Conversaciones.

---

## 8. Cuello de botella #3 — campañas masivas (N+1 secuencial)

`campaigns/send/route.ts` envía **uno por uno** en un loop: por cada contacto → 1 llamada a Meta + `insertMessage` (1 INSERT) + `insert campaign_message_status` (1 INSERT), en serie con `sleep` entre cada uno. Además **cargaba todos los destinatarios sin paginar** y el `send_limit` se aplicaba *después* de traer todo. Con el intervalo por defecto (1–3 s/mensaje) el techo real caía en **~100–150 contactos** antes del `maxDuration=300 s` → la campaña se **cortaba por timeout** a la mitad, en silencio. (La ruta vieja `campaigns/reactivacion` compartía el patrón, pero era código muerto — ver §7 — y se borró.)

> ### ✅ RESUELTO — 2026-07-05/06 (commit `c998713`)
> El loop ahora corre con **presupuesto de tiempo (270 s)**: corta limpio antes del `maxDuration`, deja la campaña en estado `enviando` y devuelve `done:false`. El **cliente reanuda automáticamente** (el wizard re-llama a `/send` hasta `done:true`, con barra de progreso). El resume se apoya en `campaign_recipients`, que ahora registra **cada intento** (éxito o fallo) → el avance es monótono y **el resume siempre termina** aunque un contacto falle siempre; `sent_count` sigue contando solo éxitos. Orden estable por `id` para que el `send_limit` y la reanudación sean deterministas entre llamadas.
>
> Verificado end-to-end (1 contacto, plantilla real): `status=completada`, `sent_count=1`, 1 fila en `campaign_recipients`. El corte-por-tiempo real (cientos de contactos) queda cubierto por lógica; no se forzó en prod por ser envíos reales.

---

## 9. Proyección honesta — ¿cuántos tenants aguanta HOY?

**Supuestos explícitos:**
- "Tenant de volumen medio-alto" = tipo Casino 17Star: ~800 contactos activos, ~700 msgs/día, 3–4 agentes, cada agente con la app abierta ~50% de su jornada y frecuentemente en Conversaciones.
- Egress medido: ~411 MB/h por agente con Conversaciones abierta. Asumo que un agente pasa ~50% de una jornada de 8 h en esa pantalla → ~1,6 GB/día/agente → ~35 GB/mes/agente.
- No hay pruning de mensajes (el historial crece).

### Escenario A — Free plan, código ACTUAL
- **Egress es el muro y ya lo estás rozando con 1 tenant.** 1 agente ~1,5 días = 5 GB. Un tenant real con 3 agentes agota el egress Free **en un día o dos**.
- **Veredicto:** el plan Free **no soporta ni siquiera 1 tenant de volumen** con el código actual. Si hoy funciona es porque el uso real es de pocas horas concentradas y/o porque el proyecto **ya está en Pro** (conviene confirmar en el dashboard). **Techo Free actual: ~1 tenant muy liviano.**

### Escenario B — Pro plan, código ACTUAL
- Egress Pro = 250 GB/mes ÷ ~35 GB/mes/agente ≈ **~7 agentes-mes** de Conversaciones **en total, sumando todos los tenants**. Eso es aprox. **2 tenants de volumen** (3–4 agentes c/u) antes de rozar el egress.
- En paralelo, el **compute compartido** (Postgres CPU) empieza a sufrir por la tormenta de re-fetches full-table disparada por `postgres_changes` sin filtro (§5): latencias y timeouts esporádicos aparecen antes del muro de egress si hay muchos eventos.
- **Veredicto:** Pro **sin tocar código** te da aire para **~2 tenants de volumen** (o varios chicos). No es "escalar", es "aguantar un poco más".

### Escenario C — Pro plan + arreglar los 2-3 cuellos de código
Con los fixes de código (§10), el egress por fetch de Conversaciones baja de **585 KB a ~5–15 KB** (traer ~30 contactos + último mensaje, no el historial completo) → **reducción 40–100×**. La tormenta de re-fetches se corta filtrando Realtime por tenant y apoyándose en el Broadcast ya migrado.
- Egress deja de ser el límite. El nuevo techo pasa a ser **compute de Postgres + cupo de mensajes Realtime**, ambos con mucho margen.
- **Veredicto:** con código arreglado, **Pro soporta cómodamente 10–20 tenants** de este tamaño. Ahí sí "escala".

### Tabla resumen

| Escenario | Tenants de volumen soportados | Primer muro |
|---|---|---|
| **Free, código actual** | **~1 (liviano)** | Egress (5 GB) |
| **Pro, código actual** | **~2** | Egress (250 GB) + CPU compartida |
| **Pro + fixes de código** | **~10–20** | CPU de Postgres / Realtime msgs |
| Free + fixes de código | ~1–2 chicos | Egress (5 GB) sigue justo; storage/media |

---

## 10. Recomendaciones priorizadas (para decidir, NO implementadas)

**El orden importa: 1 y 2 dan el 80% del beneficio y son cambios de código, no de plata.**

1. 🔴 **Paginar la lista de Conversaciones** (`conversations/route.ts`): traer ~20–30 contactos + solo el **último** mensaje de cada uno (o una columna `last_message_at` + `last_message_preview` en `contacts`), con `.range()` para scroll infinito. **Elimina el 95% del egress.** Es EL cambio de mayor impacto.
2. 🔴 **Bajar/eliminar el poll de 5 s** de Conversaciones y apoyarse en el **Broadcast** que ya migraste hoy (más una guarda de visibilidad de pestaña). El poll fijo cada 5 s es redundante con Realtime.
3. 🟠 **Filtrar los `postgres_changes` por `tenant_id`** (o migrarlos a Broadcast como hiciste con messages) para cortar el fan-out cruzado entre tenants (§5) — o al menos `realtime-dashboard`, `realtime-conversations`, `unread-badge`.
4. 🟠 **Replicar el fix de `unread_counts`** (evitar `.in()` gigante) en `campaigns/reactivacion/route.ts:31`, o chunkear a 200 como ya se hace en `contacts/import`.
5. 🟡 **Agregar índice `contacts(tenant_id, created_at)`** antes de tener tenants con muchos contactos activos.
6. 🟡 **Pasar a Supabase Pro** cuando entre el 2.º tenant de volumen — pero **después** de #1 y #2, no antes (subir de plan sin arreglar Conversaciones solo corre el muro de egress de días a semanas).
7. 🟡 **Batching en campañas** (§8): bulk insert de `messages`/`campaign_message_status` en vez de uno por uno; considerar cola/cron para campañas de miles.
8. 🟢 **Definir retención de mensajes** (archivar/borrar > N meses) para que el payload y la base no crezcan sin techo.

---

## Resultados — campaña de egress (IMPLEMENTADA, 2026-07-05/06)

Todas las recomendaciones de egress de §10 se implementaron, verificaron 1:1 contra
datos reales y están en producción. El criterio transversal fue **agregar/paginar en
Postgres en vez de traer todo y procesar en Node**.

### Los 8 commits

| # | Fix | Commit |
|---|---|---|
| 1 | Conversaciones — solo el último mensaje por contacto (RPC `fn_conversations_list`) + poll 5s→60s | `a312c86` |
| 2 | Campañas — `.in()` chunkeado (200) + auto-resume por presupuesto de tiempo (el flujo vivo era `campaigns/send`, no la pantalla vieja de reactivación) | `c998713` |
| 3 | PWA — no registrar el Service Worker en dev (evita que el fallback sirva la landing en todas las rutas) | `63379ff` |
| 4 | Dashboard + unread_counts — agregación en Postgres (4 RPCs) + fix del subconteo cap-1000 en conteos por período | `2e98720` |
| 5 | Top-clientes (iris-ai) + montos del dashboard — agregación en Postgres + fix cap-1000 | `a733829` |
| 6 | Storage — thumbnails redimensionados (`render/image`) + `loading="lazy"`; full-res solo on-demand | `fc46bd1` |
| 7 | Realtime — `filter: tenant_id=eq.<tid>` en los `postgres_changes` + sub muerta de `leads` removida | `0588ddc` |
| 8 | Leads (Top Clientes) → RPC `fn_leads_ranking` + `/api/comprobantes` paginado (keyset) | `b28dc4d` |

RPCs desplegadas en Supabase (versionadas): `supabase-conversations-list-rpc.sql`,
`supabase-dashboard-unread-rpcs.sql`, `supabase-topclients-montos-rpcs.sql`,
`supabase-leads-ranking-rpc.sql`.

### Egress Supabase→servidor por endpoint (gzip, medido — Casino 17Star)

Por hora con esa pantalla abierta en continuo:

| Endpoint | Antes/call | Después/call | Poll (a→d) | Antes/h | Después/h | Mejora |
|---|---|---|---|---|---|---|
| **Conversaciones** | 540,8 KB | 12,9 KB | 5s→60s | 380,3 MB | 0,8 MB | **501×** |
| unread_counts (badge, siempre activo) | 84,9 KB | 20,8 KB | 15s | 19,9 MB | 4,9 MB | 4× |
| dashboard_stats | 182,1 KB | 21,1 KB | 15s | 42,7 MB | 5,0 MB | 9× |
| comprobantes (bandeja) | 108,7 KB | 5,6 KB | 10s | 38,2 MB | 2,0 MB | 19× |

### Storage (browser→Storage, por apertura de Comprobantes)

| Comprobantes en lista | Full-res (antes) | Thumbnails + lazy (después) |
|---|---|---|
| 50 | 3,0 MB | ~0,2 MB |
| 200 | 12,1 MB | ~0,2 MB |

(`loading="lazy"` hace que solo bajen los ~15 thumbnails visibles; por eso 50 y 200 convergen.)

### Escenario agregado — 1 agente, 176 h-panel/mes

**Supuestos (modelo, no medición):** panel abierto 8 h × 22 días; reparto 70% Conversaciones /
15% Dashboard / 15% Comprobantes; `unread_counts` corre siempre; 6 aperturas de Comprobantes/día.

| | Egress/mes/agente | vs Free 5 GB |
|---|---|---|
| **ANTES** | **52,8 GB** | reventaba con **<1 agente** (~12–16 h-agente, coincide con §6) |
| **DESPUÉS** | **1,13 GB** | soporta **~4 agentes** en continuo |
| | **47× menos** | |

Los números por-endpoint son **medidos** (gzip real del payload contra prod); el escenario
mensual es un **modelo** con los supuestos de arriba. El grueso del ahorro es Conversaciones
(era ~90% del problema), y el cuello **dejó de escalar con el histórico** de mensajes/comprobantes.

### Correcciones de correctitud encontradas de paso
- **Subconteo cap-1000:** varios endpoints traían sin paginar y PostgREST cortaba en 1000 filas
  en silencio → el dashboard subcontaba conversaciones (`convPrevMonth` mostraba 42 cuando el real
  era 103), el ranking de Top Clientes agregaba sobre 1000 de 1065 comprobantes, y la lista de
  comprobantes quedaba incompleta (1079 > 1000). Todos corregidos al mover la agregación/paginación a SQL.
- **§7 corregida:** el `.in()` gigante "de reactivación" era código muerto (pantalla removida en `83fc01b`);
  el bug real/alcanzable estaba en `campaigns/send` y ahí se arregló.

---

## Anexo — Metodología

- **Conteos y tamaños:** medidos en vivo contra `sqovutbnotcwyygsacjx.supabase.co` vía REST API (`Prefer: count=exact`, `Range: 0-0`) con la service_role key. Sin modificar datos.
- **Egress:** medido descargando el payload real del endpoint de Conversaciones para el tenant activo, sin comprimir (3,04 MB) y con `Accept-Encoding: gzip` (585 KB en el cable). Tasas horarias = tamaño gzip × 12 requests/min (poll de 5 s).
- **Tamaño de base (~37 MB):** estimado a partir del tamaño real de fila JSON medido (contact 554 B, message 465 B) convertido a heap on-disk + overhead de índices. Es una estimación (Supabase no expone `pg_database_size` por REST); margen ±30%, pero el orden de magnitud (decenas de MB, no cientos) es sólido.
- **Índices y patrones de código:** leídos de los archivos de migración `supabase-*.sql` aplicados y del código en `src/`. No se ejecutó ni modificó nada.
- **Límites de plan:** supabase.com/pricing, verificado 2026-07-04.
- **Sin confirmar (requiere dashboard):** el plan de facturación real de Supabase (Free vs Pro) y el uso de egress/storage acumulado del mes en curso — ambos están en Supabase → Settings → Billing / Usage.
