import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        iris: {
          background: '#0a0a0f',
          card: '#111118',
          purple: '#9b30ff',
          gold: '#ffd700',
          pink: '#ff2d78',
          green: '#00ff00',
          text: '#ffffff',
          'text-muted': '#c4c4d3',
        },
      },
      boxShadow: {
        iris: '0 20px 70px rgba(155, 48, 255, 0.16)',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};

export default config;
