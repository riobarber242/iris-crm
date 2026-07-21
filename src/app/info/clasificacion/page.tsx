import type { Metadata } from 'next';

// Página PÚBLICA (sin login), pensada para compartirle al cliente. El acceso lo
// habilita el middleware: '/info' está en PUBLIC_PREFIXES. Mismo patrón que
// /privacidad.
//
// La regla que describe esta página es la de src/lib/contact-status.ts
// (deriveStatus / targetStatusFor) y la RPC reclassify_contacts. Si esa regla
// cambia, HAY QUE ACTUALIZAR ESTE TEXTO: es material que se le manda al cliente.
export const metadata: Metadata = {
  title: 'Cómo se clasifican los contactos · IRIS',
  description: 'Cuándo un contacto es Nuevo, Cliente activo o Inactivo en IRIS, y cada cuánto se actualiza.',
};

const LIMA    = '#C8FF00';
const NARANJA = '#FF5500';

const page: React.CSSProperties = {
  minHeight: '100vh', background: '#111', color: '#e8e8e8',
  fontFamily: '"DM Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  padding: '40px 20px 72px', lineHeight: 1.65,
};
const wrap: React.CSSProperties = { maxWidth: '720px', margin: '0 auto' };
const kicker: React.CSSProperties = {
  fontSize: '12px', fontWeight: 800, letterSpacing: '0.16em', textTransform: 'uppercase',
  color: NARANJA, margin: 0,
};
const h1: React.CSSProperties = { fontSize: '30px', fontWeight: 900, margin: '6px 0 0', letterSpacing: '-0.02em', color: '#fff' };
const rule: React.CSSProperties = { height: '4px', width: '56px', background: LIMA, borderRadius: '4px', margin: '16px 0 10px' };
const lead: React.CSSProperties = { fontSize: '16px', color: '#bdbdbd', margin: '0 0 30px' };
const h2: React.CSSProperties = { fontSize: '19px', fontWeight: 800, margin: '38px 0 12px', color: '#fff' };
const p: React.CSSProperties = { fontSize: '15px', color: '#ccc', margin: '0 0 12px' };

const card: React.CSSProperties = {
  background: '#1a1a1a', borderRadius: '14px', padding: '18px 20px', marginBottom: '10px',
  border: '1px solid #262626',
};
const cardTitle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: '10px',
  fontSize: '16px', fontWeight: 800, color: '#fff', margin: '0 0 6px',
};
const cardText: React.CSSProperties = { fontSize: '14px', color: '#b5b5b5', margin: 0 };

const box = (borde: string, fondo: string): React.CSSProperties => ({
  background: fondo, border: `1px solid ${borde}`, borderLeft: `4px solid ${borde}`,
  borderRadius: '12px', padding: '16px 18px', margin: '0 0 14px',
});

function Dot({ color }: { color: string }) {
  return <span style={{ width: 12, height: 12, borderRadius: '50%', background: color, display: 'inline-block', flexShrink: 0 }} />;
}

export default function ClasificacionPage() {
  return (
    <main style={page}>
      <div style={wrap}>
        <p style={kicker}>IRIS</p>
        <h1 style={h1}>Cómo se clasifican los contactos</h1>
        <div style={rule} />
        <p style={lead}>
          Cada contacto tiene una categoría que el sistema asigna solo. Se basa en una única señal:
          los <b style={{ color: '#fff' }}>comprobantes verificados</b>. Ni los mensajes, ni el tiempo
          desde el alta, ni la actividad en el chat modifican la categoría.
        </p>

        <h2 style={h2}>Las tres categorías</h2>

        <div style={card}>
          <p style={cardTitle}><Dot color="#4FC3F7" /> Nuevo</p>
          <p style={cardText}>
            Nunca tuvo un comprobante verificado. No significa “recién llegado”: un contacto de hace un año
            que nunca cargó sigue siendo Nuevo.
          </p>
        </div>

        <div style={card}>
          <p style={cardTitle}><Dot color={LIMA} /> Cliente activo</p>
          <p style={cardText}>
            Tiene al menos un comprobante verificado <b style={{ color: '#fff' }}>en el mes calendario en curso</b>.
            Alcanza con uno.
          </p>
        </div>

        <div style={card}>
          <p style={cardTitle}><Dot color="#777" /> Inactivo</p>
          <p style={cardText}>
            Tuvo comprobantes verificados alguna vez, pero <b style={{ color: '#fff' }}>ninguno este mes</b>.
          </p>
        </div>

        <h2 style={h2}>El corte es por mes calendario, no por cantidad de días</h2>
        <div style={box(NARANJA, '#241505')}>
          <p style={{ ...p, margin: 0, color: '#f0d6c0' }}>
            No existe un umbral de “30 días sin cargar”. El límite es el
            <b style={{ color: '#fff' }}> 1° de cada mes a las 00:00</b> (hora Argentina): quien todavía no
            cargó en el mes nuevo pasa a Inactivo.
          </p>
        </div>
        <p style={p}>Por eso los días reales sin cargar varían entre 1 y 31:</p>

        <div style={card}>
          <p style={{ ...cardText, margin: '0 0 8px' }}>
            <b style={{ color: LIMA }}>Cargó el 30 de junio</b> → pasa a Inactivo el <b style={{ color: '#fff' }}>1 de julio</b>.
            Un solo día después.
          </p>
          <p style={{ ...cardText, margin: 0 }}>
            <b style={{ color: LIMA }}>Cargó el 2 de julio</b> → sigue Activo hasta el <b style={{ color: '#fff' }}>1 de agosto</b>.
            Casi 30 días.
          </p>
        </div>

        <p style={p}>
          Volver de Inactivo a Cliente activo es inmediato: con un solo comprobante verificado en el mes en
          curso, vuelve. No hay período de espera ni monto mínimo.
        </p>

        <h2 style={h2}>Cada cuánto se actualiza</h2>
        <p style={p}>
          <b style={{ color: '#fff' }}>Al instante</b>, cuando se verifica un comprobante desde el panel: la
          categoría de ese contacto se recalcula en el momento.
        </p>
        <p style={p}>
          <b style={{ color: '#fff' }}>Todas las noches a las 00:00</b> (hora Argentina), con un repaso general
          de toda la base. Es el que hace el corte de fin de mes.
        </p>

        <h2 style={h2}>La categoría se pone sola</h2>
        <div style={box('#8a6d1f', '#241f05')}>
          <p style={{ ...p, margin: 0, color: '#e8dcb0' }}>
            Si se cambia la categoría a mano desde la ficha del contacto, el sistema la vuelve a calcular y
            <b style={{ color: '#fff' }}> revierte el cambio</b>. La única fuente de verdad son los comprobantes
            verificados. La excepción es <b style={{ color: '#fff' }}>Bloqueado</b>, que nunca se toca de forma
            automática.
          </p>
        </div>

        <h2 style={h2}>No confundir con el filtro de campañas</h2>
        <p style={p}>
          En el asistente de campañas existe la opción <b style={{ color: '#fff' }}>“Inactivo sin recargar X días”</b>.
          Esa <b style={{ color: '#fff' }}>sí</b> usa días reales y es configurable, pero es solo un filtro para
          armar la lista de destinatarios de una campaña: <b style={{ color: '#fff' }}>no</b> es la categoría del
          contacto ni la modifica.
        </p>

        <p style={{ fontSize: '13px', color: '#777', marginTop: '48px', borderTop: '1px solid #262626', paddingTop: '18px' }}>
          IRIS · Plataforma de atención y gestión por WhatsApp
        </p>
      </div>
    </main>
  );
}
