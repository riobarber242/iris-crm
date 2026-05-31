import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        iris: {
          background: '#0A0A0A',
          card: '#111111',
          cardStrong: '#141414',
          green: '#C6FF00',
          text: '#FFFFFF',
          'text-muted': '#888888',
        },
      },
      boxShadow: {
        iris: '0 16px 40px rgba(198, 255, 0, 0.12)',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};

export default config;
