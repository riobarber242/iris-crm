// Thumbnails vía la transformación de imágenes de Supabase Storage (endpoint
// `render/image`, disponible en el plan Pro del proyecto). Reescribe la URL
// pública `/storage/v1/object/public/<bucket>/<path>` a
// `/storage/v1/render/image/public/<bucket>/<path>?width=..&quality=..`, que
// sirve una versión redimensionada (KBs) en vez de la foto full-res.
//
// El driver de egress era la lista de Comprobantes: renderizaba CADA imagen
// full-res (~61 KB prom, hasta 806 KB) en un thumbnail de 88px. Con esto cada
// miniatura pesa ~11 KB. La imagen completa se sigue sirviendo on-demand (el
// lightbox / click usa la URL original).
//
// Solo aplica a imágenes raster servidas desde Storage público. Cualquier otra
// URL (PDF, externa, data:) se devuelve intacta — el llamador ya separa PDFs.
export function thumbUrl(url: string | null | undefined, width: number, quality = 50): string | null {
  if (!url) return url ?? null;
  const marker = '/storage/v1/object/public/';
  if (!url.includes(marker)) return url; // no es Storage público → sin cambio
  const rendered = url.replace(marker, '/storage/v1/render/image/public/');
  const sep = rendered.includes('?') ? '&' : '?';
  return `${rendered}${sep}width=${width}&quality=${quality}`;
}
