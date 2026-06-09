import { NextResponse } from 'next/server';
import { getSessionAgent } from '@/lib/current-agent';

// Transcripción de audio del chat de Iris AI vía Groq Whisper.
// Recibe multipart/form-data con el campo "audio" (blob webm/ogg) y devuelve { text }.
export const runtime = 'nodejs';

const GROQ_TRANSCRIBE_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const WHISPER_MODEL = 'whisper-large-v3-turbo';

export async function POST(request: Request) {
  const session = await getSessionAgent();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'Transcripción no configurada (falta GROQ_API_KEY).' }, { status: 500 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Form-data inválido' }, { status: 400 });
  }

  const audio = form.get('audio');
  if (!(audio instanceof Blob) || audio.size === 0) {
    return NextResponse.json({ error: 'Falta el audio' }, { status: 400 });
  }

  // Groq necesita un filename con extensión para inferir el formato.
  const filename = audio instanceof File && audio.name ? audio.name : 'audio.webm';

  const groqForm = new FormData();
  groqForm.append('file', audio, filename);
  groqForm.append('model', WHISPER_MODEL);
  groqForm.append('response_format', 'json');
  groqForm.append('language', 'es');

  try {
    const res = await fetch(GROQ_TRANSCRIBE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: groqForm,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error('[iris transcribe] groq error', res.status, detail);
      return NextResponse.json({ error: 'Error transcribiendo el audio.' }, { status: 502 });
    }

    const data = await res.json();
    return NextResponse.json({ text: String(data?.text ?? '').trim() });
  } catch (err: any) {
    console.error('[iris transcribe] error', err?.message ?? err);
    return NextResponse.json({ error: 'Error transcribiendo el audio.' }, { status: 500 });
  }
}
