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
};

export default nextConfig;
