import { after, NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { getSessionAgent } from '@/lib/current-agent';
import { logActivity, ACTIVITY } from '@/lib/activity-log';
import { broadcastComprobanteChange } from '@/lib/realtime-broadcast';
import { makeThumb, thumbPathFor } from '@/lib/thumb-generate';

// Carga manual de un pago hecho por el agente desde afuera (premio grande pagado
// por fuera del sistema). SOLO admin/agent. Sube la imagen del comprobante y
// crea un pago `pago_agente=true` SIN contacto asociado. Al verificarlo en la
// bandeja Pagos suben las fichas al pozo, pero NO baja la billetera de ningún
// operador (la lógica vive en aplicarPagoComprobante / PATCH de comprobantes).
export async function POST(req: NextRequest) {
  const session = await getSessionAgent();
  if (!session) return new NextResponse('No autenticado', { status: 401 });

  // Defensa server-side: el operator no carga pagos manuales.
  if (session.role !== 'admin' && session.role !== 'agent') {
    return new NextResponse('Solo un agente o admin puede cargar pagos manuales', { status: 403 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return new NextResponse('Formato inválido', { status: 400 });
  }

  const file  = form.get('file') as File | null;
  const monto = Math.trunc(Number(form.get('monto')));
  if (!Number.isFinite(monto) || monto <= 0) {
    return new NextResponse('Ingresá un monto válido (mayor a 0)', { status: 400 });
  }

  // La imagen es opcional pero recomendada: si vino, la subimos a Storage.
  let imageUrl: string | null = null;
  if (file && typeof file.arrayBuffer === 'function' && file.size > 0) {
    const ext  = (file.type.split('/')[1] ?? 'jpg').replace('jpeg', 'jpg');
    const path = `pago-manual/${session.tenant_id}/${Date.now()}.${ext}`;
    const buffer = Buffer.from(await file.arrayBuffer());
    const { error: uploadError } = await supabaseAdmin.storage
      .from('comprobantes')
      .upload(path, buffer, { contentType: file.type || 'image/jpeg', upsert: true });
    if (uploadError) {
      return new NextResponse(`No se pudo subir la imagen: ${uploadError.message}`, { status: 500 });
    }
    // Thumb pre-generado (best-effort, en after()): solo si es imagen raster (el
    // comprobante puede venir como PDF). Si falla, el front cae al original.
    if ((file.type || '').startsWith('image/')) {
      after(async () => {
        try {
          const thumb = await makeThumb(buffer);
          if (thumb) {
            await supabaseAdmin.storage
              .from('comprobantes')
              .upload(thumbPathFor(path), thumb, { contentType: 'image/webp', upsert: true });
          }
        } catch (err) {
          console.warn('[pago-manual] No se pudo generar/subir el thumb:', err);
        }
      });
    }
    imageUrl = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/comprobantes/${path}`;
  }

  // Pago del agente: tipo='pago', pago_agente=true, sin contacto. Queda
  // 'pendiente' para que se verifique en la bandeja Pagos (sube fichas allí).
  const { data, error } = await supabaseAdmin
    .from('comprobantes')
    .insert({
      contact_id:  null,
      image_url:   imageUrl,
      monto,
      estado:      'pendiente',
      tipo:        'pago',
      pago_agente: true,
      tenant_id:   session.tenant_id,
    })
    .select('*')
    .single();

  if (error) {
    // Sin la migración stage4 (tipo/pago_agente/contact_id nullable) esto no
    // puede funcionar: lo decimos claro en vez de fallar en silencio.
    if (/pago_agente|tipo|contact_id|null value|column|schema cache/i.test(error.message)) {
      return new NextResponse('La caja de pagos no está inicializada (falta correr supabase-caja-fichas-stage4.sql).', { status: 400 });
    }
    return new NextResponse(error.message, { status: 500 });
  }

  // Fase 2: señal de comprobante nuevo (aparece en la bandeja Pagos / badge). Best-effort.
  await broadcastComprobanteChange(session.tenant_id).catch(() => {});

  await logActivity({
    session,
    action:     ACTIVITY.COMPROBANTE_ENVIADO,
    objectType: 'comprobante',
    objectId:   data.id,
    details:    { tipo: 'pago', pago_agente: true, manual: true, monto },
  });

  return NextResponse.json(data, { status: 201 });
}
