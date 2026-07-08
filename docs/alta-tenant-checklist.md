# Checklist de alta de un tenant/cliente nuevo (punta a punta)

> Objetivo: dar de alta un cliente nuevo (ej. Derki) sin depender de la memoria de nadie.
> Cubre el lado de **Meta**, el lado de **Supabase**, la **verificación** final y los **gotchas** ya pisados.
>
> Última actualización: 2026-07-08 (tras el alta de Derki: bloqueo de cuenta de Meta,
> `app_secret` por número, columna `messages.type` que faltaba hace 5 semanas).

---

## 0. Decidir el modelo de credenciales ANTES de empezar

Hay dos formas de conectar un número, y definen casi todo el resto:

- **App global (como Casino 17Star):** el número usa las credenciales globales de env
  (`WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `META_APP_SECRET`, `WHATSAPP_WABA_ID`).
  En `whatsapp_numbers` los campos `access_token` / `app_secret` / `waba_id` quedan **null**
  (se resuelven al global). Sirve solo si el número vive dentro de la MISMA app de Meta que el resto.
- **App propia del cliente (como Derki):** el cliente tiene su **propia app de Meta**. Entonces
  `access_token`, `app_secret` y `waba_id` van **en la fila `whatsapp_numbers`** (NO en env).
  Si te olvidás alguno: los webhooks entrantes dan **401 (firma inválida)** y/o los envíos usan
  las credenciales equivocadas (las globales de otro cliente).

> Regla de oro: **un `phone_number_id` = una app de Meta**. Si el cliente trae su propia app,
> es camino "app propia" y TODO va en la fila.

---

## 1. Lado de Meta (Business / Developers)

- [ ] **Meta Business verificado** (Business Manager). Sin negocio verificado no se pueden
      enviar plantillas ni levantar los límites de mensajería.
- [ ] **App de Meta** (si el cliente usa app propia): tipo *Business*, producto *WhatsApp* agregado.
- [ ] **Número de WhatsApp** dado de alta en la WABA y con nombre para mostrar aprobado.
- [ ] Anotar los tres IDs: **`phone_number_id`**, **`waba_id`** (WhatsApp Business Account ID)
      y el número visible.
- [ ] **System User** (usuario del sistema) en Business Settings con rol sobre la WABA, y generar
      un **access token permanente** (no el token temporal de 24 h del panel de pruebas).
- [ ] **App Secret**: copiarlo de *App Settings → Basic → App Secret* (son 32 chars hex).
- [ ] **Webhook de la app** apuntando a `https://<tu-dominio>/api/webhook`:
  - Callback URL: `.../api/webhook`
  - **Verify token: el `WHATSAPP_VERIFY_TOKEN` global existente** (es único para TODAS las apps;
    no se inventa uno por cliente — hay que poner el mismo que ya usa el sistema).
  - Suscribir el campo **`messages`** en la WABA.
- [ ] Confirmar que la app/número **no esté en restricción/bloqueo** de Meta (pasó hoy con Derki:
      Meta bloqueó la cuenta y no entregaba webhooks; se resolvió del lado de Meta, no del código).

---

## 2. Lado de Supabase

### 2.1 Migraciones (esquema — compartido por toda la instancia)

Si es una instancia ya viva, el esquema ya está. Si es DB nueva, correr **todas** las migraciones
`supabase-*.sql` del repo. Imprescindibles para un tenant funcional:

- [ ] `supabase-schema.sql`, `supabase-auth-migration.sql`, `supabase-multitenant.sql`,
      `supabase-multitenant-fix.sql`
- [ ] `supabase-whatsapp-numbers.sql` (tabla de líneas) + **`supabase-app-secret.sql`**
      (columna `app_secret` — imprescindible para app propia)
- [ ] `supabase-onboarding-wizard.sql` (`whatsapp_waba_id`, `whatsapp_display_number` en tenants)
- [ ] `supabase-operator-role.sql` (si el cliente usa operadores) + `supabase-operator-permissions.sql`
      + `supabase-multioperador.sql`
- [ ] `supabase-message-type.sql`, `supabase-message-author-role.sql`, `supabase-reactions.sql`,
      `supabase-reply-to.sql`, `supabase-quick-replies-tenant.sql`, `supabase-activity-log.sql`
- [ ] Campañas (si aplica): `supabase-campaigns.sql`, `-campaign-recipients.sql`,
      `-campaign-tracking.sql`, `-campaign-daily-limit.sql`
- [ ] Caja de fichas (si aplica): `supabase-caja-fichas.sql` + stages 3–6 + `migraciones-caja-mejoras-*.sql`
      + `supabase-bono-comprobante.sql` + `supabase-realtime-comprobantes.sql`
- [ ] Casino/DoDeposit (si aplica): `supabase-casino-deposit.sql`
- [ ] `supabase-enable-rls.sql` (RLS) y `supabase-fix-function-search-path.sql`
- [ ] ⚠️ **`whatsapp_templates`**: NO tiene `create table` en el repo (ver Gotchas). Verificar que
      la tabla exista antes de usar plantillas.

> Recordatorio: tras un `ALTER TABLE`, PostgREST recarga el schema cache solo (event trigger de
> Supabase). No hace falta `NOTIFY pgrst, 'reload schema'` salvo cambios que no sean DDL.

### 2.2 Fila(s) en `whatsapp_numbers` (lo que "enciende" el número)

Insertar una fila por línea del cliente:

- [ ] `tenant_id` → el tenant del cliente
- [ ] `phone_number_id` → el de Meta (numérico, **único**)
- [ ] `waba_id` → el de Meta (necesario para plantillas)
- [ ] `access_token` → token permanente propio (si app propia). null solo si usa el global.
- [ ] `app_secret` → los 32 chars del App Secret (si app propia). null solo si usa el global.
- [ ] `is_default = true` (el primer número queda default automático) y `active = true`
- [ ] `label` → nombre visible ("Línea 1", etc.)

### 2.3 `settings` (config por tenant — clave `(key, tenant_id)`)

El wizard de alta crea el `system_prompt`. Revisar/cargar el resto según lo contratado:

- [ ] `system_prompt` (lo crea el alta; personalizar por cliente)
- [ ] `bot_enabled`, `bot_mode`, `offline_mode`, `offline_msg` (si falta `offline_msg`, usa un default)
- [ ] `caja_enabled` (módulo Caja)
- [ ] `whatsapp_agente` → número del equipo para el canal interno de caja (si usa Caja con handoff)
- [ ] `casino_deposit_enabled` + (si se activa) `casino_api_base_url`, `casino_player_url`,
      `casino_player_url_2`, `casino_credentials_template` — **todos juntos o ninguno**
- [ ] Permisos por operador: `can_see_top_clients`, `can_see_campaigns` (default false)

### 2.4 Datos iniciales (opcionales pero recomendados)

- [ ] `whatsapp_templates`: crear al menos una plantilla y aprobarla vía
      `POST /api/whatsapp-templates/submit-to-meta` **si el cliente va a hacer campañas o responder
      fuera de la ventana de 24 h**. Sin plantillas aprobadas no puede iniciar conversaciones.
- [ ] `quick_replies`: cargar las respuestas rápidas habituales (comodidad, no bloquea nada).

---

## 3. Verificación antes de dar por "andando"

- [ ] **Mensaje de prueba entrante:** el cliente (o vos desde otro WhatsApp) manda un mensaje al
      número. Debe **aparecer en Conversaciones** en segundos.
- [ ] **Confirmar en la DB** que se guardó: fila en `messages` con `role='user'`, el `content`
      correcto y `whatsapp_message_id`. (Query rápida por `tenant_id`.)
- [ ] **Respuesta saliente:** un operador responde desde el CRM y confirma que **llega al WhatsApp**
      del cliente (verifica que `resolveCreds` use el token propio del número, no el global).
- [ ] **Logs limpios** (Vercel → Functions, filtrar por el `phone_number_id`):
  - Sin `[webhook] Firma inválida` → el `app_secret` está bien.
  - Sin `[webhook] Insert mensaje usuario falló … reintentando` → el esquema está completo.
- [ ] **Roles:** el cliente tiene al menos un `agent` y los operadores necesarios; login OK.
- [ ] **Paridad de features** contra un tenant de referencia (ej. Casino 17Star): comparar las
      `settings` key por key para no dejar flags a medio configurar.

---

## 4. Gotchas (cosas que YA pisamos — no repetir)

1. **Bloqueo de cuenta de Meta (08/07/2026):** los webhooks pueden dejar de llegar por una
   restricción del lado de Meta, sin que haya nada roto en el código. Antes de tocar código,
   descartar bloqueo/restricción de la cuenta en Business Manager.
2. **`app_secret` por número (multi-app):** un cliente con app propia DEBE tener su `app_secret`
   en la fila `whatsapp_numbers`. Si falta y tampoco hay `META_APP_SECRET` global → el webhook
   se rechaza con 401 (fail-closed, commit 40243ff). El `verify_token` en cambio es **global y único**
   para todas las apps.
3. **`WHATSAPP_VERIFY_TOKEN` es único global:** en Meta, todas las apps deben configurar el MISMO
   verify token (no uno por cliente).
4. **Credenciales atómicas:** `resolveCreds` devuelve token+phone_id como par del MISMO origen.
   Nunca mezclar el token de un cliente con el phone_id de otro (por eso todo va junto en la fila).
5. **Columna `messages.type` faltaba desde el 2026-06-01:** el webhook mandaba `type` en el insert
   y la columna no existía → cada mensaje fallaba el 1er insert y se guardaba por el retry (que
   además descartaba `reply_to_*`). Corregido con `supabase-message-type.sql`. Lección: si en los
   logs aparece *"Could not find the 'X' column of 'Y' in the schema cache"*, es una **columna que
   no existe** (no un cache viejo) — falta correr una migración.
6. **`whatsapp_templates` no tiene `create table` en el repo:** existe en producción porque se creó
   a mano; en una DB nueva hay que crearla manualmente (o falla el CRUD de plantillas). Pendiente:
   agregar una migración `.sql` para esta tabla.
7. **Emoji "cuadradito" (□):** NO es bug de la app ni de codificación — es la versión de la fuente
   de emojis del SO (Segoe UI Emoji en Windows) que no tiene los emojis más nuevos (Emoji 14.0+).
   El codepoint se guarda y viaja bien. No se arregla por CSS; solo actualizando el SO o
   empaquetando una webfont de emojis a color (se descartó por peso).
8. **Casino/DoDeposit gateado:** con `casino_deposit_enabled != 'true'` el endpoint devuelve 403 y
   ni lee las URLs; si se activa, cargar las 4 keys `casino_*` juntas o la creación de jugador falla.

---

## Apéndice — Estado de Derki al 2026-07-08 (referencia)

- Modelo: **app propia**. `whatsapp_numbers` con `access_token` (204), `app_secret` (32), `waba_id`
  (`1039432561759076`), `phone_number_id` `1141177249087761`, `is_default=true`, `active=true`. ✅
- Webhook recibiendo 200; envío saliente OK; core CRM/caja/auto-verificación a la par de 17Star.
- **Gaps (config, no bugs):** `casino_deposit_enabled=false` (+ keys `casino_*` ausentes → inertes),
  `whatsapp_agente` ausente, `offline_msg` ausente (usa default), **0 `whatsapp_templates`** (no puede
  campañas/fuera-de-24h hasta crear+aprobar una), 0 `quick_replies`.
- Roles: 1 `agent` + 1 `operator` (el `admin` vive en el tenant Principal, como en 17Star).
