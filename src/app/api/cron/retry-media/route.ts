import { NextRequest, NextResponse } from 'next/server';
import { getSessionAgent } from '@/lib/current-agent';
import { supabaseAdmin } from '@/lib/db';
import { resolveCreds } from '@/lib/meta/client';
import { saveComprobanteImage } from '@/lib/meta/handler';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Reintenta descargar la media entrante que quedó pending (Meta caído al recibirla).
// El webhook guarda {_type, pending:true, media_id, …} en vez del literal "image";
// este cron barre esos mensajes, reintenta saveComprobanteImage(media_id) y, al
// éxito, reescribe el content con la url real. La ventana de Meta es corta (la media
// se purga a la ~media hora), así que conviene correrlo seguido (*/5).
//
// Corte: tras MAX_ATTEMPTS intentos o si el mensaje es más viejo que MAX_AGE, se
// marca failed (pending:false) → el chat muestra "no disponible" y deja de barrerse.

const MAX_ATTEMPTS = 6;
const MAX_AGE_MS   = 24 * 60 * 60 * 1000;

// Reconstruye el JSON "descargado OK" desde el pending, preservando metadata.
function successContent(p: any, url: string): string {
  const out: any = { _type: p._type, url };
  if (p._type === 'image' || p._type === 'video') out.caption = p.caption ?? '';
  if (p._type === 'document') { out.filename = p.filename ?? null; out.mime = p.mime ?? null; out.caption = p.caption ?? ''; }
  return JSON.stringify(out);
}

async function handle(req: NextRequest) {
  // Auth dual (igual que /api/cron/backfill-thumbs): staff logueado o secret headless.
  const session  = await getSessionAgent();
  const isStaff  = !!session && (session.role === 'admin' || session.role === 'agent');
  const secret   = process.env.CRON_SECRET;
  const secretOk = !!secret && req.headers.get('authorization') === `Bearer ${secret}`;
  if (!isStaff && !secretOk) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const limit = Math.min(Math.max(Number(searchParams.get('limit') ?? 20), 1), 100);

  const { data: rows, error } = await supabaseAdmin
    .from('messages')
    .select('id, content, contact_id, tenant_id, created_at')
    .like('content', '%"pending":true%')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  let recovered = 0, stillPending = 0, gaveUp = 0, skipped = 0;

  for (const row of rows ?? []) {
    let p: any;
    try { p = JSON.parse(row.content); } catch { skipped++; continue; }
    if (!p?.pending || !p?.media_id) { skipped++; continue; }

    const attempts = Number(p.attempts ?? 0) + 1;
    const tooOld   = Date.now() - new Date(row.created_at).getTime() > MAX_AGE_MS;

    // Token del número que recibió el mensaje (el media solo baja con ese token).
    let token: string | null = null;
    try {
      const { data: c } = await supabaseAdmin
        .from('contacts').select('whatsapp_number_id').eq('id', row.contact_id).maybeSingle();
      token = (await resolveCreds(row.tenant_id, c?.whatsapp_number_id ?? null)).token;
    } catch { /* token null → saveComprobanteImage logea y devuelve null */ }

    const url = await saveComprobanteImage(p.media_id, row.contact_id, token);

    if (url) {
      // Guard: solo si sigue pending (evita pisar una edición/concurrencia).
      await supabaseAdmin.from('messages')
        .update({ content: successContent(p, url) })
        .eq('id', row.id).like('content', '%"pending":true%');
      recovered++;
      continue;
    }

    if (attempts >= MAX_ATTEMPTS || tooOld) {
      // Se agotó: Meta ya no la retiene. Marcar failed → "no disponible" en el chat.
      await supabaseAdmin.from('messages')
        .update({ content: JSON.stringify({ ...p, pending: false, failed: true, attempts }) })
        .eq('id', row.id);
      gaveUp++;
    } else {
      // Sigue pending: guardar el contador para el próximo barrido.
      await supabaseAdmin.from('messages')
        .update({ content: JSON.stringify({ ...p, attempts }) })
        .eq('id', row.id);
      stillPending++;
    }
  }

  return NextResponse.json({ ok: true, procesados: rows?.length ?? 0, recovered, stillPending, gaveUp, skipped });
}

// Vercel Cron invoca por GET; POST queda para correr a mano.
export const GET  = handle;
export const POST = handle;
