import { NextResponse } from 'next/server';
import axios from 'axios';
import { getSessionAgent } from '@/lib/current-agent';
import { resolveCreds } from '@/lib/meta/client';

// Trae las plantillas aprobadas de Meta para el tenant.
// Estrategia: usa el phone_number_id del número default del tenant (resolveCreds)
// para resolver el waba_id via Graph API (/{phone_number_id}?fields=whatsapp_business_account)
// y luego consulta /{waba_id}/message_templates?status=APPROVED.
// Devuelve { name, language, status, body } por plantilla.

const GRAPH = 'https://graph.facebook.com/v19.0';

type MetaTemplate = {
  name: string;
  language: string;
  status: string;
  components?: { type: string; text?: string }[];
};

export async function GET() {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });

  // Token + phone_number_id a usar: número default activo del tenant (o env global).
  const { token, phoneId } = await resolveCreds(session.tenant_id);

  try {
    // 1) phone_number_id → waba_id
    const phoneRes = await axios.get(`${GRAPH}/${phoneId}`, {
      params: { fields: 'whatsapp_business_account', access_token: token },
      timeout: 10000,
    });
    const wabaId = phoneRes.data?.whatsapp_business_account?.id;
    if (!wabaId) {
      return NextResponse.json(
        { error: 'No se pudo resolver el WABA del número. Verificá el token en Configuración.' },
        { status: 502 },
      );
    }

    // 2) waba_id → plantillas aprobadas
    const tplRes = await axios.get(`${GRAPH}/${wabaId}/message_templates`, {
      params: { status: 'APPROVED', limit: 50, access_token: token },
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
    const reason = err?.response?.data?.error?.message || err?.message || 'Error desconocido';
    return NextResponse.json(
      { error: `No se pudieron cargar las plantillas: ${reason}` },
      { status: 502 },
    );
  }
}
