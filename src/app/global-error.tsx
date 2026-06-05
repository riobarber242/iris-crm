'use client';

// Error boundary raíz: captura errores que rompen el propio layout (incluido
// el <html>/<body>). Por eso debe renderizar su propia estructura HTML.
import { useEffect } from 'react';

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error('[global error boundary]', error);
  }, [error]);

  return (
    <html lang="es">
      <body style={{ margin: 0, fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif', background: '#F5F5F5', color: '#1a1a1a' }}>
        <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }}>
          <div style={{ background: '#fff', borderRadius: '20px', padding: '32px', maxWidth: '440px', width: '100%', textAlign: 'center', boxShadow: '0 2px 16px rgba(0,0,0,0.08)' }}>
            <p style={{ fontSize: '40px', margin: '0 0 8px 0' }}>⚠️</p>
            <h2 style={{ fontSize: '20px', fontWeight: 800, margin: '0 0 8px 0' }}>La aplicación tuvo un error</h2>
            <p style={{ fontSize: '14px', color: '#666', margin: '0 0 24px 0' }}>
              Algo falló al cargar la app. Reintentá o recargá la página.
            </p>
            <div style={{ display: 'flex', gap: '10px', justifyContent: 'center' }}>
              <button
                onClick={reset}
                style={{ background: '#C8FF00', color: '#000', fontWeight: 700, fontSize: '14px', border: 'none', borderRadius: '12px', padding: '12px 20px', cursor: 'pointer' }}
              >
                Reintentar
              </button>
              <button
                onClick={() => window.location.reload()}
                style={{ background: '#F5F5F5', color: '#1a1a1a', fontWeight: 700, fontSize: '14px', border: 'none', borderRadius: '12px', padding: '12px 20px', cursor: 'pointer' }}
              >
                Recargar
              </button>
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}
