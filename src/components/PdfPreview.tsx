'use client';
import React, { useEffect, useRef, useState } from 'react';

// Vista previa de un PDF: renderiza la PRIMERA PÁGINA en un <canvas> (como si
// fuera una imagen) usando pdf.js. Click → abre el PDF completo en pestaña nueva.
// pdf.js se carga lazy (dynamic import) solo en el browser; el worker se sirve
// desde /public/pdf.worker.min.mjs (copiado de pdfjs-dist en build/local).
export default function PdfPreview({
  url,
  filename,
  maxWidth = 280,
  showLabel = true,
}: {
  url: string;
  filename?: string | null;
  maxWidth?: number;
  showLabel?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [state, setState] = useState<'loading' | 'done' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const pdfjs = await import('pdfjs-dist');
        pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
        const pdf = await pdfjs.getDocument({ url }).promise;
        const page = await pdf.getPage(1);
        if (cancelled) return;
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min((maxWidth * 2) / base.width, 3); // 2x para nitidez
        const viewport = page.getViewport({ scale });
        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        // pdfjs v6: `canvas` es el parámetro principal (obtiene el contexto solo).
        await page.render({ canvas, viewport }).promise;
        if (!cancelled) setState('done');
      } catch {
        if (!cancelled) setState('error');
      }
    })();
    return () => { cancelled = true; };
  }, [url, maxWidth]);

  const open = (e: React.MouseEvent) => {
    e.stopPropagation();
    window.open(url, '_blank', 'noopener,noreferrer');
  };
  const label = filename || 'Documento PDF';

  // Si pdf.js falla (PDF corrupto, worker no disponible), degradar a un link.
  if (state === 'error') {
    return (
      <a href={url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}
         style={{ fontSize: '13px', textDecoration: 'underline', color: 'inherit' }}>
        📄 {label} · abrir
      </a>
    );
  }

  return (
    <div onClick={open} title="Abrir PDF en una pestaña nueva"
         style={{ cursor: 'pointer', maxWidth, width: '100%' }}>
      <div style={{
        position: 'relative', borderRadius: '10px', overflow: 'hidden',
        background: '#00000010', minHeight: state === 'loading' ? 80 : undefined,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {state === 'loading' && (
          <span style={{ position: 'absolute', fontSize: '12px', color: '#999' }}>📄 …</span>
        )}
        <canvas ref={canvasRef} style={{ display: state === 'done' ? 'block' : 'none', width: '100%', height: 'auto' }} />
      </div>
      {showLabel && (
        <p style={{ margin: '5px 0 0 0', fontSize: '12px', opacity: 0.7, wordBreak: 'break-all' }}>📄 {label}</p>
      )}
    </div>
  );
}
