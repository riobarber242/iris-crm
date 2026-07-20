import { supabaseAdmin } from '@/lib/db';
import { listMessageTemplates } from '@/lib/meta/client';
import { listTenantWabas } from '@/lib/waba';

// Sincroniza el estado de aprobación de las plantillas del tenant contra Meta.
//
// Iris guarda las plantillas en whatsapp_templates, pero quien decide si se pueden
// usar es Meta: hasta que no las aprueba, mandarlas falla EN SILENCIO (132001).
// Acá consultamos la Graph API de cada WABA del tenant y bajamos a la DB:
//   · approval_status  → el punto de color de la UI (verde aprobada / naranja en revisión)
//   · waba_id          → si la plantilla era legacy (null), queda adoptada por la WABA
//                        donde Meta efectivamente la tiene registrada
//   · meta_template_id → id en Meta, útil para diagnóstico
//
// Es best-effort: si una WABA falla (token sin permisos, red), se registra el error
// y las demás igual se sincronizan. Nunca tira: la pantalla debe abrir igual.

export type TemplateSyncResult = { updated: number; wabas: number; errors: string[] };

// Clave de matcheo con lo que devuelve Meta. El idioma es parte de la identidad de
// una plantilla en Meta (mismo nombre puede existir en es y en es_AR).
const key = (name: string, language: string) => `${name.trim().toLowerCase()}|${(language || '').trim().toLowerCase()}`;

export async function syncTemplateStatuses(tenantId: string): Promise<TemplateSyncResult> {
  const errors: string[] = [];

  const { data: rows, error } = await supabaseAdmin
    .from('whatsapp_templates')
    .select('id, name, language, waba_id, approval_status, meta_template_id')
    .eq('tenant_id', tenantId);

  if (error) return { updated: 0, wabas: 0, errors: [error.message] };
  if (!rows || rows.length === 0) return { updated: 0, wabas: 0, errors };

  let wabas;
  try {
    wabas = await listTenantWabas(tenantId);
  } catch (err: any) {
    return { updated: 0, wabas: 0, errors: [err?.message ?? 'No se pudieron resolver las WABAs del tenant.'] };
  }
  if (wabas.length === 0) return { updated: 0, wabas: 0, errors: ['El tenant no tiene líneas activas con WABA cargada.'] };

  const now = new Date().toISOString();
  let updated = 0;

  for (const waba of wabas) {
    let metaList;
    try {
      metaList = await listMessageTemplates(waba.wabaId, waba.token);
    } catch (err: any) {
      const msg = err?.response?.data?.error?.message || err?.message || 'error desconocido';
      errors.push(`WABA ${waba.wabaId}: ${msg}`);
      continue;
    }

    // Índice por nombre+idioma, y por nombre solo (fallback cuando el idioma
    // registrado en Meta no coincide exacto con el que se cargó en Iris).
    const byKey = new Map<string, typeof metaList[number]>();
    const byName = new Map<string, typeof metaList[number][]>();
    for (const t of metaList) {
      byKey.set(key(t.name, t.language), t);
      const list = byName.get(t.name.trim().toLowerCase()) ?? [];
      list.push(t);
      byName.set(t.name.trim().toLowerCase(), list);
    }

    for (const row of rows) {
      // Solo tocamos plantillas de ESTA WABA o legacy (sin WABA asignada): una
      // plantilla ya atribuida a otra WABA no se re-adopta por un homónimo.
      if (row.waba_id && row.waba_id !== waba.wabaId) continue;

      const sameName = byName.get(row.name.trim().toLowerCase()) ?? [];
      const match = byKey.get(key(row.name, row.language)) ?? (sameName.length === 1 ? sameName[0] : undefined);
      if (!match) continue;

      const patch: Record<string, unknown> = { status_synced_at: now };
      if (match.status !== row.approval_status) patch.approval_status = match.status;
      if (match.id && match.id !== row.meta_template_id) patch.meta_template_id = match.id;
      if (!row.waba_id) patch.waba_id = waba.wabaId;
      // `updated` cuenta cambios REALES (no el simple sello de "sincronizado"),
      // que es lo que se le informa al operador.
      const huboCambio = Object.keys(patch).length > 1;

      const { error: uErr } = await supabaseAdmin
        .from('whatsapp_templates')
        .update(patch)
        .eq('id', row.id)
        .eq('tenant_id', tenantId);

      if (uErr) errors.push(`No se pudo actualizar "${row.name}": ${uErr.message}`);
      else {
        if (huboCambio) updated++;
        // Reflejamos el cambio en memoria para que otra WABA del mismo tenant no
        // vuelva a considerar esta fila como legacy en la vuelta siguiente.
        if (!row.waba_id) row.waba_id = waba.wabaId;
        row.approval_status = match.status;
      }
    }
  }

  return { updated, wabas: wabas.length, errors };
}
