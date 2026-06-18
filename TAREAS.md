# Tareas pendientes — IRIS

> Última actualización: 2026-06-18 (caja en tiempo real en producción)
> Documento de seguimiento entre sesiones. Estado de cada tarea: **PENDIENTE** / **EN CURSO** / **HECHO**.

---

## ✅ HECHO — Paquete de notificaciones (completo)

- [HECHO] Cuelgue del botón "Activar notificaciones" (timeout, ahora muestra "Reintentar").
- [HECHO] Badge de no-leído en el sidebar (fix typo `conversations` → `conversaciones`).
- [HECHO] El circulito de no-leído se limpia solo al **ABRIR** la conversación (no al tocar la fila).
- [HECHO] "Visto": último operador que vio cada conversación (cartelito "Visto por X"; migración `last_seen_by` / `last_seen_at` corrida).

## ✅ HECHO — Rendimiento

- [HECHO] Navegación rápida entre secciones (layout compartido + esqueleto de carga, el menú ya no se reconstruye).

## ✅ HECHO — Tiempo real (repaso completo)

- [HECHO] **Repaso de tiempo real, criterio cumplido punta a punta:**
  - Realtime: conversaciones / mensajes / chat interno / cargas-pagos ✓ y **caja-billeteras** (CajaResumen, MiCajaClient, FichasClient suscritos al INSERT de `movimientos`; poll 15s de respaldo) ✓.
  - Refresco cada pocos segundos: contadores / listas (contactos, campañas) ✓.
  - Al-entrar: configuraciones ✓.
  - Tablas `movimientos` / `fichas_stock` / `operador_billetera` habilitadas en la publicación `supabase_realtime`.
  - Solo display: NO tocó la lógica de plata (eso sigue en Caja Etapa 2, abajo).

---

## 🟡 PENDIENTE — Chica

- [PENDIENTE] Sacar WhatsApp del agente de Configuración (key `whatsapp_agente`).
  **Ojo:** está atada a Caja Etapa 2 — el cierre de turno todavía la usa con `wa.me`. No se puede sacar sola.

---

## 🔴 PENDIENTE — Grandes (cada una su propia sesión)

- [PENDIENTE] **Caja Etapa 2 (PLATA REAL — la más delicada).**
  - Cierre de turno con verificación diferida: sube comprobante → el turno cierra ya, la billetera se acredita cuando **OTRO** operador verifica.
  - Elegir a qué operador se le hace el traspaso al cerrar.
  - Que el agente cargue saldo a billeteras de operadores con comprobante verificado.
  - Requiere investigación previa a fondo de `fn_cobrar_sueldo` y toda la lógica de caja. **NADA a ciegas.**

- [PENDIENTE] **Rediseño del panel del Admin.** Vista de gestión de agentes/tenants (no fichas/recargas, que es de operador).
  Uso futuro: alta de clientes/agentes, conectar números API.

---

## 📌 Recordatorio personal (no es código)

- Cambiar la contraseña de **isa** (la pone Gonzalo desde el panel).
