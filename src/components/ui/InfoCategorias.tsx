import React from 'react';

// Botón ⓘ que abre la página pública con la explicación de las categorías
// (Nuevo / Cliente activo / Inactivo). Va al lado de todo selector de categoría:
// es donde el operador se pregunta por qué el estado cambió solo, o por qué su
// cambio manual se revirtió.
//
// Se abre en pestaña nueva a propósito: la página es pública y se le comparte al
// cliente, y así no se pierde lo que se estaba editando.
export function InfoCategorias({ title }: { title?: string }) {
  return (
    <a
      href="/info/clasificacion"
      target="_blank"
      rel="noopener noreferrer"
      title={title ?? 'Cómo se calculan las categorías (se abre en una pestaña nueva)'}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: '18px', height: '18px', borderRadius: '50%', flexShrink: 0,
        border: '1.5px solid #bbb', color: '#888',
        fontSize: '11px', fontWeight: 800, lineHeight: 1,
        textDecoration: 'none', cursor: 'pointer',
      }}
    >
      i
    </a>
  );
}
