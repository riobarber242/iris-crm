// Esqueleto del área de contenido durante la navegación entre secciones.
// Como AdminShell vive en el layout del grupo, el shell (header + sidebar) queda
// fijo y SOLO este esqueleto ocupa el slot de contenido mientras el server
// component de la sección resuelve sus datos: la pantalla aparece al instante.
export default function PanelLoading() {
  const bar = (w: string, h = 16) => ({
    width: w,
    height: `${h}px`,
    borderRadius: '8px',
    background: 'linear-gradient(90deg,#ececec 25%,#f5f5f5 37%,#ececec 63%)',
    backgroundSize: '400% 100%',
    animation: 'iris-skeleton 1.2s ease-in-out infinite',
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }} aria-busy="true" aria-label="Cargando…">
      {/* Título */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <div style={bar('240px', 24)} />
        <div style={bar('160px', 14)} />
      </div>

      {/* Tarjetas de contenido */}
      {Array.from({ length: 4 }).map((_, i) => (
        <div
          key={i}
          style={{
            background: '#fff',
            borderRadius: '16px',
            padding: '20px',
            boxShadow: '0 1px 8px rgba(0,0,0,0.06)',
            display: 'flex',
            flexDirection: 'column',
            gap: '12px',
          }}
        >
          <div style={bar('60%')} />
          <div style={bar('90%')} />
          <div style={bar('40%')} />
        </div>
      ))}

      <style>{`
        @keyframes iris-skeleton {
          0%   { background-position: 100% 50%; }
          100% { background-position: 0 50%; }
        }
      `}</style>
    </div>
  );
}
