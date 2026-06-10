import './globals.css';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { AuthProvider } from '@/components/AuthProvider';
import PWARegister from '@/components/PWARegister';

export const metadata: Metadata = {
  title: 'Iris',
  description: 'Panel premium de Iris con asistente virtual y dashboard oscuro.',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'IRIS',
  },
  icons: {
    apple: '/icon-192.png',
  },
};

export const viewport: Viewport = {
  themeColor: '#C8FF00',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700;800&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <AuthProvider>
          <PWARegister />
          {children}
        </AuthProvider>
      </body>
    </html>
  );
}
