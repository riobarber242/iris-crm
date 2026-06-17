import { NextResponse } from 'next/server';
import axios from 'axios';
import { getSessionAgent } from '@/lib/current-agent';
import { supabaseAdmin } from '@/lib/db';

// Trae las plantillas aprobadas de Meta para el tenant.
// Para listar plantillas hace falta el WABA ID (no el phone_number_id). El
// phone number node de la Graph API NO expone un campo directo al WABA, así que
// lo resolvemos en cascada (ver resolveWabaId). Una vez con el WABA:
//   GET /{waba_id}/message_templates?status=APPROVED
// Devuelve { name, language, status, body } por plantilla.

// v18.0: misma versión que lib/meta/client.ts usa para envíos. Si Meta
// devuelve #100 con esta versión, probar bajando a 'v17.0'.
const GRAPH = 'https://graph.facebook.com/v18.0';

type MetaTemplate = {
  name: string;
  language: string;
  status: string;
  components?: { type: string; text?: string }[];
};

// Resuelve el WABA ID a usar para listar plantillas, en orden de robustez:
//   1. waba_id ya guardado en la fila del número (lo más confiable).
//   2. GET /{phone_number_id}?fields=id,display_phone_number,account_id → account_id.
//   3. GET /me?fields=granular_scopes,id → primer WABA con permiso
//      whatsapp_business_management/messaging del System User del token.
//   4. WABA global de env (WHATSAPP_BUSINESS_ACCOUNT_ID / WHATSAPP_WABA_ID).
async function resolveWabaId(
  token: string,
  phoneId: string,
  dbWabaId: string | null,
): Promise<string | null> {
  // 1) WABA guardado en DB
  if (dbWabaId) return dbWabaId;

  // 2) account_id del phone number node
  try {
    const res = await axios.get(`${GRAPH}/${phoneId}`, {
      params: { fields: 'id,display_phone_number,account_id', access_token: token },
      timeout: 10000,
    });
    const accountId = res.data?.account_id;
    if (accountId) return String(accountId);
  } catch { /* sigue con el próximo fallback */ }

  // 3) granular_scopes del token (System User): primer WABA con permiso de WhatsApp
  try {
    const res = await axios.get(`${GRAPH}/me`, {
      params: { fields: 'granular_scopes,id', access_token: token },
      timeout: 10000,
    });
    const scopes: { scope: string; target_ids?: string[] }[] = res.data?.granular_scopes ?? [];
    const waScope =
      scopes.find((s) => s.scope === 'whatsapp_business_management') ??
      scopes.find((s) => s.scope === 'whatsapp_business_messaging');
    const first = waScope?.target_ids?.[0];
    if (first) return String(first);
  } catch { /* sigue con el fallback de env */ }

  // 4) WABA global de env
  return process.env.WHATSAPP_BUSINESS_ACCOUNT_ID ?? process.env.WHATSAPP_WABA_ID ?? null;
}

export async function GET() {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });

  // Número default activo del tenant: de ahí salen token, phone_id y waba_id.
  // Si el tenant no tiene número propio, caemos a las credenciales globales de env.
  const { data: line } = await supabaseAdmin
    .from('whatsapp_numbers')
    .select('phone_number_id, access_token, waba_id')
    .eq('tenant_id', session.tenant_id)
    .eq('is_default', true)
    .eq('active', true)
    .maybeSingle();

  const token   = line?.access_token || process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneId = line?.phone_number_id || process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!token) {
    return NextResponse.json(
      { error: 'No hay access token configurado. Verificá el token en Configuración.' },
      { status: 502 },
    );
  }

  try {
    const wabaId = await resolveWabaId(token, phoneId ?? '', line?.waba_id ?? null);
    if (!wabaId) {
      return NextResponse.json(
        { error: 'No se pudo resolver el WABA. Cargá el WABA ID del número en Configuración.' },
        { status: 502 },
      );
    }

    const tplRes = await axios.get(`${GRAPH}/${wabaId}/message_templates`, {
      params: {
        fields: 'name,status,language,components',
        status: 'APPROVED',
        limit: 50,
        access_token: token,
      },
      timeout: 10000,
    });

    const data: MetaTemplate[] = tplRes.data?.data ?? [];
    const templates = data.map((t) => ({
      name: t.name,
      language: t.language,
      status: t.status,
      body: t.components?.find((c) => c.type === 'BODY')?.text ?? '',
    }));

    return NextResponse.json(templates);
  } catch (err: any) {
    const metaErr = err?.response?.data?.error;
    const reason  = metaErr?.message || err?.message || 'Error desconocido';
    const code    = metaErr?.code;
    // Log completo de lo que devuelve Meta para diagnóstico.
    console.error('[campaigns/templates] Error Meta:', JSON.stringify(err?.response?.data ?? err?.message));
    return NextResponse.json(
      { error: `No se pudieron cargar las plantillas: ${reason}`, code, meta: metaErr ?? null },
      { status: 502 },
    );
  }
}
