import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // ffmpeg-static resuelve su binario con __dirname. Si webpack lo bundlea,
  // __dirname apunta a .next/server/... y el binario no se encuentra. Lo
  // mantenemos externo (require desde node_modules) para que __dirname sea
  // correcto en runtime.
  serverExternalPackages: ['ffmpeg-static'],
  // Vercel no incluye binarios no-importados en el bundle serverless por
  // defecto: forzamos que el binario de ffmpeg-static viaje con la función que
  // remuxea el audio a ogg/opus.
  outputFileTracingIncludes: {
    '/api/messages/audio': ['./node_modules/ffmpeg-static/**'],
  },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**',
      },
    ],
  },
  // Rutas del panel unificadas a español. Redirects 308 para no romper links
  // viejos. NO se redirige /configuracion: con el swap pasó a ser una ruta viva
  // (la antigua Configuración); redirigirla taparía esa página.
  async redirects() {
    return [
      // Canonicalizar al dominio propio: todo lo que entre por la URL de Vercel
      // se manda a irisonline.app, MENOS /api/* (el webhook de Meta y el cron de
      // Vercel pegan por path en el dominio de deploy) y /_next/* (assets). Así
      // las suscripciones push se crean siempre con origen irisonline.app y no
      // quedan firmadas como iris-crm-kappa.vercel.app. 307 (no permanente) para
      // poder entrar a la URL de Vercel a depurar sin un redirect cacheado duro.
      {
        source: '/:path((?!api/|_next/).*)',
        has: [{ type: 'host', value: 'iris-crm-kappa.vercel.app' }],
        destination: 'https://irisonline.app/:path',
        permanent: false,
      },
      { source: '/conversations/:path*', destination: '/conversaciones/:path*', permanent: true },
      { source: '/contacts/:path*',      destination: '/contactos/:path*',      permanent: true },
      { source: '/leads/:path*',         destination: '/top-clientes/:path*',   permanent: true },
      { source: '/settings/:path*',      destination: '/configuracion/:path*',  permanent: true },
      // Comprobantes pasó a llamarse Cargas (Etapa 4a). 308 para no romper links.
      { source: '/comprobantes/:path*',  destination: '/cargas/:path*',         permanent: true },
      { source: '/comprobantes',         destination: '/cargas',                permanent: true },
    ];
  },
};

export default nextConfig;
