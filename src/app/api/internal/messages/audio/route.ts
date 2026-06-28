import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { requireInternalMember, resolveRoom } from '@/lib/internal-chat';
import { toOggOpus } from '@/lib/audio/toOggOpus';

// POST /api/internal/messages/audio — nota de voz en el chat interno.
// multipart/form-data: file, roomId?. El navegador graba en webm/opus (Chrome)
// u ogg/opus (Firefox); remuxeamos a OGG/Opus reusando toOggOpus (igual criterio
// que /api/messages/audio) para que el <audio> reproduzca consistente en el CRM.
// Como es interno, NO se envía a WhatsApp/Meta. Se guarda en el bucket
// 'comprobantes' con prefijo interno-audio/${tenant_id}/${room_id}/.
export async function POST(req: NextRequest) {
  try {
    const session = await requireInternalMember();
    if (!session) return NextResponse.json({ error: 'No autorizado' }, { status: 403 });

    const form = await req.formData();
    const file = form.get('file') as File | null;
    const roomId = (form.get('roomId') as string | null) ?? null;

    if (!file) return NextResponse.json({ error: 'file requerido' }, { status: 400 });

    const room = await resolveRoom(session.tenant_id, roomId, session.sub);
    if (!room) return NextResponse.json({ error: 'Sala no encontrada' }, { status: 404 });

    const baseMime = file.type.split(';')[0].trim();
    const rawBuffer = Buffer.from(await file.arrayBuffer());

    // Si ya viene en ogg (Firefox) se saltea; si viene en webm/opus (Chrome) se
    // remuxea copiando el stream (-c:a copy): rápido y sin pérdida.
    let audioBuffer: Buffer = rawBuffer;
    if (baseMime !== 'audio/ogg') {
      try {
        audioBuffer = await toOggOpus(rawBuffer);
      } catch (err) {
        console.error('[internal/messages/audio] remux a ogg/opus falló:', err);
        return NextResponse.json({ error: 'No se pudo convertir el audio a formato compatible.' }, { status: 500 });
      }
    }

    const path = `interno-audio/${session.tenant_id}/${room.id}/${Date.now()}.ogg`;

    const { error: uploadError } = await supabaseAdmin.storage
      .from('comprobantes')
      .upload(path, audioBuffer, { contentType: 'audio/ogg', upsert: true });

    if (uploadError) return NextResponse.json({ error: uploadError.message }, { status: 500 });

    const publicUrl = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/comprobantes/${path}`;
    const content = JSON.stringify({ _type: 'audio', url: publicUrl });

    const { data: saved, error: dbError } = await supabaseAdmin
      .from('internal_messages')
      .insert({
        tenant_id:   session.tenant_id,
        room_id:     room.id,
        author_id:   session.sub,
        author_name: session.name,
        author_role: session.role,
        content,
      })
      .select('*')
      .single();

    if (dbError || !saved) return NextResponse.json({ error: dbError?.message ?? 'Error guardando' }, { status: 500 });

    return NextResponse.json(saved, { status: 201 });
  } catch (err: any) {
    console.error('[internal/messages/audio POST] Error inesperado:', err);
    return NextResponse.json({ error: 'Error interno enviando el audio' }, { status: 500 });
  }
}
