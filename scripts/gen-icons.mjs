// Genera public/icon-192.png y public/icon-512.png:
// fondo negro (#000000), texto "IRIS" en verde lima (#C8FF00), bold.
// Usa @napi-rs/canvas (binarios prebuilt, sin toolchain nativo).
//
//   node scripts/gen-icons.mjs
//
import { createCanvas } from '@napi-rs/canvas';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

function makeIcon(size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  // Fondo negro.
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, size, size);

  // Texto "IRIS" centrado, verde lima, bold.
  ctx.fillStyle = '#C8FF00';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `bold ${Math.round(size * 0.30)}px sans-serif`;
  ctx.fillText('IRIS', size / 2, size / 2 + size * 0.02);

  return canvas.toBuffer('image/png');
}

for (const size of [192, 512]) {
  const out = join(PUBLIC_DIR, `icon-${size}.png`);
  writeFileSync(out, makeIcon(size));
  console.log(`✓ ${out}`);
}
