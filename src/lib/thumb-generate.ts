// Generación de thumbnails al SUBIR (server-side, con sharp), en vez de pedir la
// transformación al vuelo al endpoint `render/image` de Supabase en cada vista.
//
// Por qué: Supabase factura Image Transformations por imagen ORIGEN distinta
// transformada por ciclo (las vistas repetidas las cachea la CDN y no re-cuentan).
// Cada comprobante/imagen de chat nueva = +1. Pre-generando el thumb con nuestro
// compute (sharp, gratis) y sirviéndolo como objeto estático, esas imágenes dejan
// de contar como "transformadas" → el contador cae a ~0. Ver [[thumb.ts]] por el
// lado del front (deriva la ruta estática de la miniatura).
//
// El thumb es un sibling determinístico del original en el MISMO bucket:
//   operator/123/1699.jpg  →  operator/123/1699.jpg.thumb.webp
// Así el front deriva la URL sin columna nueva en la DB (ver thumbPathFor).
import sharp from 'sharp';

// Un solo tamaño para todos los consumidores (lista de comprobantes 200px, chat
// 480px, avatares): 400px webp entra nítido en todos y pesa ~15-25 KB.
const THUMB_WIDTH   = 400;
const THUMB_QUALITY = 55;

// Ruta de la miniatura pre-generada a partir de la ruta del original dentro del
// bucket. Determinística: el front la reconstruye igual desde la URL pública.
export function thumbPathFor(path: string): string {
  return `${path}.thumb.webp`;
}

// Redimensiona a webp. Devuelve null si el buffer no es una imagen raster que
// sharp pueda procesar (ej. un PDF o un formato raro): en ese caso el caller sube
// el original sin thumb y el front cae al original vía onError. NO usa render/image
// (cero transforms de Supabase).
//
// - rotate() sin args respeta la orientación EXIF (fotos de celular rotadas).
// - fit:'inside' + withoutEnlargement: escala proporcional sin recortar ni agrandar
//   (equivale al resize=contain que usaba render/image; evita cortar comprobantes).
export async function makeThumb(buffer: Buffer): Promise<Buffer | null> {
  try {
    return await sharp(buffer)
      .rotate()
      .resize({ width: THUMB_WIDTH, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: THUMB_QUALITY })
      .toBuffer();
  } catch (err) {
    console.warn('[thumb] makeThumb no pudo procesar el buffer (¿no es raster?):', err);
    return null;
  }
}
