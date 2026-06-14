import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';

// Remux (NO re-encode) de un audio con codec Opus a contenedor OGG/Opus.
// WhatsApp solo entrega notas de voz en OGG/Opus; el navegador (Chrome) graba
// en webm/opus, así que cambiamos el contenedor copiando el stream de audio
// tal cual (-c:a copy): rápido y sin pérdida de calidad.
export async function toOggOpus(input: Buffer): Promise<Buffer> {
  if (!ffmpegPath) throw new Error('[toOggOpus] ffmpeg-static no disponible');

  return new Promise<Buffer>((resolve, reject) => {
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-i', 'pipe:0',
      '-vn', '-c:a', 'copy',
      '-f', 'ogg', 'pipe:1',
    ];
    const proc = spawn(ffmpegPath as unknown as string, args);

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    proc.stdout.on('data', (d) => out.push(d as Buffer));
    proc.stderr.on('data', (d) => err.push(d as Buffer));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0 && out.length > 0) {
        resolve(Buffer.concat(out));
      } else {
        reject(new Error(`[toOggOpus] ffmpeg code=${code}: ${Buffer.concat(err).toString()}`));
      }
    });

    proc.stdin.on('error', () => {}); // ignora EPIPE si ffmpeg cierra antes de tiempo
    proc.stdin.write(input);
    proc.stdin.end();
  });
}
