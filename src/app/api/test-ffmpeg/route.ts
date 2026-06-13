// Endpoint TEMPORAL de validación: confirma que el binario de ffmpeg-static
// existe y se puede ejecutar en el entorno serverless de Vercel. Se elimina
// una vez verificado, antes de armar el remux real de audio.
import { NextResponse } from 'next/server';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const execFileAsync = promisify(execFile);

export async function GET() {
  try {
    if (!ffmpegPath) {
      return NextResponse.json({ ok: false, error: 'ffmpeg-static no devolvió path' }, { status: 500 });
    }
    const exists = existsSync(ffmpegPath);
    if (!exists) {
      return NextResponse.json(
        { ok: false, path: ffmpegPath, exists, error: 'binario no encontrado en el bundle' },
        { status: 500 },
      );
    }
    const { stdout } = await execFileAsync(ffmpegPath, ['-version']);
    const version = stdout.split('\n')[0];
    return NextResponse.json({ ok: true, path: ffmpegPath, exists, version });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message ?? String(err) }, { status: 500 });
  }
}
