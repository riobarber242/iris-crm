import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Vercel no incluye binarios no-importados en el bundle serverless por
  // defecto: forzamos que el binario de ffmpeg-static viaje con la función.
  outputFileTracingIncludes: {
    '/api/_test-ffmpeg': ['./node_modules/ffmpeg-static/**'],
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
