import type { Metadata } from 'next';

// Página PÚBLICA (sin login) — se usa como URL de política de privacidad en las
// apps de Meta de los clientes. El acceso público lo habilita el middleware:
// '/privacidad' está en PUBLIC_PREFIXES. Si dejara de estar, Meta se toparía con el
// login al validar la URL y la rechazaría.
export const metadata: Metadata = {
  title: 'Política de Privacidad · IRIS',
  description: 'Cómo IRIS recolecta, usa y protege los datos en su plataforma de atención por WhatsApp.',
};

const LAST_UPDATED = '18 de julio de 2026';
const CONTACT_EMAIL = 'iris.online2026@gmail.com';

const page: React.CSSProperties = {
  minHeight: '100vh', background: '#fafafa', color: '#1a1a1a',
  fontFamily: '"DM Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  padding: '32px 20px 64px', lineHeight: 1.65,
};
const wrap: React.CSSProperties = { maxWidth: '720px', margin: '0 auto' };
const h1: React.CSSProperties = { fontSize: '28px', fontWeight: 800, margin: '0 0 4px', letterSpacing: '-0.02em' };
const rule: React.CSSProperties = { height: '4px', width: '56px', background: '#C8FF00', borderRadius: '4px', margin: '14px 0 8px' };
const meta: React.CSSProperties = { fontSize: '13px', color: '#888', margin: '0 0 28px' };
const h2: React.CSSProperties = { fontSize: '18px', fontWeight: 800, margin: '30px 0 8px', color: '#111' };
const p: React.CSSProperties = { fontSize: '15px', color: '#333', margin: '0 0 12px' };
const ul: React.CSSProperties = { fontSize: '15px', color: '#333', margin: '0 0 12px', paddingLeft: '20px' };
const li: React.CSSProperties = { margin: '0 0 6px' };
const foot: React.CSSProperties = { fontSize: '13px', color: '#999', marginTop: '40px', borderTop: '1px solid #e6e6e6', paddingTop: '16px' };

export default function PrivacidadPage() {
  return (
    <main style={page}>
      <div style={wrap}>
        <p style={{ fontSize: '13px', fontWeight: 800, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#7a8a00', margin: 0 }}>
          IRIS
        </p>
        <h1 style={h1}>Política de Privacidad</h1>
        <div style={rule} />
        <p style={meta}>Última actualización: {LAST_UPDATED}</p>

        <p style={p}>
          IRIS es una plataforma de atención al cliente y gestión de conversaciones (CRM) que opera sobre
          WhatsApp. La usan negocios para comunicarse con sus clientes, responder consultas y gestionar sus
          operaciones. Esta política explica qué datos tratamos, con qué finalidad y cómo los protegemos.
        </p>
        <p style={p}>
          Cada negocio que usa IRIS es responsable de los datos de sus propios clientes; IRIS actúa como
          proveedor tecnológico que trata esos datos por cuenta del negocio para prestarle el servicio.
        </p>

        <h2 style={h2}>1. Qué datos recolectamos</h2>
        <ul style={ul}>
          <li style={li}><b>Mensajes de WhatsApp:</b> el contenido de las conversaciones entre el negocio y sus clientes (texto, imágenes, audios y archivos enviados).</li>
          <li style={li}><b>Datos de contacto:</b> número de teléfono y nombre del contacto tal como figura en WhatsApp o como lo carga el negocio.</li>
          <li style={li}><b>Comprobantes:</b> imágenes de comprobantes de pago o recarga y sus montos, cuando el cliente los envía para ser verificados.</li>
          <li style={li}><b>Metadatos de la conversación:</b> fecha y hora de los mensajes, estado de lectura, y por qué línea de WhatsApp ingresó cada contacto.</li>
        </ul>

        <h2 style={h2}>2. Para qué usamos los datos</h2>
        <ul style={ul}>
          <li style={li}>Prestar el servicio de atención y CRM: mostrar, organizar y responder las conversaciones.</li>
          <li style={li}>Enviar y recibir mensajes de WhatsApp entre el negocio y sus clientes.</li>
          <li style={li}>Verificar comprobantes de pago o recarga cuando esa función está activada.</li>
          <li style={li}>Mantener el historial de la relación para dar continuidad a la atención.</li>
        </ul>
        <p style={p}>
          No usamos los datos de las conversaciones para publicidad ni para fines distintos de la prestación
          del servicio contratado por el negocio.
        </p>

        <h2 style={h2}>3. Con quién se comparten</h2>
        <p style={p}>
          <b>No vendemos ni cedemos los datos a terceros</b> con fines comerciales o publicitarios. Los datos
          solo se procesan a través de los proveedores de infraestructura estrictamente necesarios para operar
          el servicio, que actúan como encargados de tratamiento bajo obligación de confidencialidad:
        </p>
        <ul style={ul}>
          <li style={li}><b>WhatsApp / Meta:</b> como canal de mensajería por el que viajan los mensajes.</li>
          <li style={li}><b>Proveedores de hosting y base de datos:</b> para alojar la aplicación y almacenar la información de forma segura.</li>
        </ul>
        <p style={p}>
          Los datos de cada negocio están aislados de los de los demás: un negocio nunca accede a las
          conversaciones ni a los contactos de otro.
        </p>

        <h2 style={h2}>4. Cómo los protegemos</h2>
        <ul style={ul}>
          <li style={li}><b>Cifrado en tránsito:</b> toda la comunicación viaja sobre HTTPS.</li>
          <li style={li}><b>Cifrado en reposo:</b> las credenciales y secretos sensibles se guardan cifrados con AES-256-GCM; la clave de cifrado se mantiene separada de la base de datos.</li>
          <li style={li}><b>Acceso restringido:</b> el acceso está segmentado por negocio (cada cliente solo ve sus propios datos) y limitado por rol de usuario.</li>
        </ul>

        <h2 style={h2}>5. Conservación de los datos</h2>
        <p style={p}>
          Conservamos los datos mientras el negocio mantenga activo el servicio. Si un negocio deja de usar
          IRIS o solicita la eliminación de datos, estos se eliminan o anonimizan dentro de un plazo razonable,
          salvo obligación legal de conservarlos.
        </p>

        <h2 style={h2}>6. Tus derechos</h2>
        <p style={p}>
          Podés solicitar acceder, rectificar o eliminar tus datos personales. Como los datos de las
          conversaciones pertenecen al negocio con el que te comunicás, la vía más directa es contactarlo a él;
          también podés escribirnos a la dirección de contacto de abajo y te ayudamos a canalizar el pedido.
        </p>

        <h2 style={h2}>7. Menores de edad</h2>
        <p style={p}>
          El servicio está dirigido a negocios y a personas mayores de edad. No recolectamos de forma
          intencional datos de menores.
        </p>

        <h2 style={h2}>8. Cambios en esta política</h2>
        <p style={p}>
          Podemos actualizar esta política para reflejar cambios en el servicio o en la normativa. Publicaremos
          la versión vigente en esta misma dirección, con su fecha de última actualización.
        </p>

        <h2 style={h2}>9. Contacto</h2>
        <p style={p}>
          Ante cualquier consulta sobre esta política o sobre el tratamiento de datos, escribinos a:{' '}
          <a href={`mailto:${CONTACT_EMAIL}`} style={{ color: '#111', fontWeight: 700 }}>{CONTACT_EMAIL}</a>.
        </p>

        <p style={foot}>© {new Date().getFullYear()} IRIS · Política de Privacidad</p>
      </div>
    </main>
  );
}
