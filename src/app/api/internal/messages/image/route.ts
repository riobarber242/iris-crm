import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { requireInternalMember, resolveRoom } from '@/lib/internal-chat';

// POST /api/internal/messages/image — imagen en el chat interno.
// multipart/form-data: file, caption?, roomId?. Sube al bucket 'comprobantes'
// con prefijo interno/${tenant_id}/${room_id}/ (mismo patrón service-role que
// /api/messages/image) y guarda el mensaje como JSON {_type:'image',url,caption}.
// NO sale a WhatsApp/Meta.
export async function POST(req: NextRequest) {
  try {
    const session = await requireInternalMember();
    if (!session) return NextResponse.json({ error: 'No autorizado' }, { status: 403 });

    const form = await req.formData();
    const file = form.get('file') as File | null;
    const caption = ((form.get('caption') as string | null) ?? '').trim();
    const roomId = (form.get('roomId') as string | null) ?? null;

    if (!file) return NextResponse.json({ error: 'file requerido' }, { status: 400 });

    const room = await resolveRoom(session.tenant_id, roomId);
    if (!room) return NextResponse.json({ error: 'Sala no encontrada' }, { status: 404 });

    const ext = (file.type.split('/')[1] ?? 'jpg').replace('jpeg', 'jpg');
    const path = `interno/${session.tenant_id}/${room.id}/${Date.now()}.${ext}`;
    const buffer = Buffer.from(await file.arrayBuffer());

    const { error: uploadError } = await supabaseAdmin.storage
      .from('comprobantes')
      .upload(path, buffer, { contentType: file.type, upsert: true });

    if (uploadError) return NextResponse.json({ error: uploadError.message }, { status: 500 });

    const publicUrl = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/comprobantes/${path}`;
    const content = JSON.stringify({ _type: 'image', url: publicUrl, caption });

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
    console.error('[internal/messages/image POST] Error inesperado:', err);
    return NextResponse.json({ error: 'Error interno enviando la imagen' }, { status: 500 });
  }
}
