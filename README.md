# CRM de Iris

CRM completo para Iris, una cajera virtual de entretenimiento online con interfaz oscuro estilo fintech.

## Stack

- Next.js 15 (App Router) + TypeScript
- Supabase (base de datos y storage)
- WhatsApp Business API oficial de Meta (Cloud API)
- Groq API con modelo `llama-3.3-70b-versatile`
- Vercel
- Tailwind CSS 4

## Estructura básica

- `src/app`: páginas del panel de administración
- `src/app/api`: webhooks y endpoints API
- `src/lib`: lógica de Supabase, WhatsApp y Groq
- `src/components`: componentes UI y layout
- `supabase-schema.sql`: esquema completo para Supabase

## Variables de entorno

Copia `.env.example` a `.env.local` y completá los valores:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `WHATSAPP_PHONE_NUMBER_ID`
- `WHATSAPP_ACCESS_TOKEN`
- `WHATSAPP_VERIFY_TOKEN`
- `GROQ_API_KEY`
- `META_PIXEL_ID`
- `META_CONVERSIONS_ACCESS_TOKEN`
- `CRON_SECRET`
- `NEXTAUTH_SECRET`

## Instalación

```bash
npm install
```

## Desarrollo

```bash
npm run dev
```

## Validación de tipos

```bash
npm run typecheck
```

## Esquema de Supabase

Usá `supabase-schema.sql` para crear las tablas:

- `contacts`
- `messages`
- `comprobantes`
- `leads`
- `settings`
- `campaigns`

## Rutas principales

- `GET /api/webhook` - verificación de Meta
- `POST /api/webhook` - recibe mensajes de WhatsApp
- `GET /api/conversations` - lista contactos y conversaciones
- `PATCH /api/conversations` - actualiza estado de contacto
- `GET /api/messages` - historial de mensajes por contacto
- `POST /api/messages` - envío manual humano
- `GET /api/comprobantes` - lista de comprobantes
- `PATCH /api/comprobantes` - verificar o rechazar comprobantes
- `GET /api/campaigns` - lista campañas
- `POST /api/campaigns` - crear campaña
- `PATCH /api/campaigns` - cambiar estado de campaña

## Panel de administración

- `/dashboard`
- `/conversations`
- `/comprobantes`
- `/leads`
- `/campanas`
- `/settings`

## Nota de diseño

La interfaz usa una paleta oscura premium con acentos púrpura, dorado, rosa y verde neón. El estilo está pensado para un dashboard fintech moderno.
