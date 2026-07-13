// Miniaturas servidas como objetos ESTÁTICOS pre-generados en Storage, no vía la
// transformación al vuelo de Supabase (render/image). Cada imagen se sube junto a
// su sibling `<path>.thumb.webp` (~400px) en los 6 puntos de subida (ver
// thumb-generate.ts); acá el front solo deriva esa ruta. Motivo: render/image se
// factura por imagen ORIGEN transformada por ciclo; los .webp estáticos no cuentan
// como transformación (solo egress/storage) → el contador de transforms cae a ~0.
//
// thumbUrl: URL pública `/storage/v1/object/public/<bucket>/<path>` → la del thumb
// `…/<path>.thumb.webp`. Cualquier otra URL (PDF, externa, data:) se devuelve
// intacta. Los args width/quality quedan por compatibilidad de firma con los
// call-sites (un único tamaño para todos); ya no se usan.
//
// Si el thumb no existe (imagen previa al backfill que no se pudo pre-generar), el
// <img> cae al original con fallbackToOriginal() en el onError del componente.
export function thumbUrl(url: string | null | undefined, _width?: number, _quality?: number): string | null {
  if (!url) return url ?? null;
  const marker = '/storage/v1/object/public/';
  if (!url.includes(marker)) return url; // no es Storage público → sin cambio
  return `${url}.thumb.webp`;
}

// onError para <img src={thumbUrl(x) ?? x}>: si la miniatura estática no existe,
// cae UNA vez al original full-res. El flag data-fellback evita el loop infinito si
// el original también falla.
export function fallbackToOriginal(original: string) {
  return (e: { currentTarget: HTMLImageElement }) => {
    const img = e.currentTarget;
    if (img.dataset.fellback === '1') return; // el original también falló → no insistir
    img.dataset.fellback = '1';
    img.src = original;
  };
}
