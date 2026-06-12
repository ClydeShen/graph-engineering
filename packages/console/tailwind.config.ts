import type { Config } from 'tailwindcss';

// Industrial cold palette (UI-SPEC: 工业冷色调, no component library).
export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: '#0d1117',
        panel: '#161b22',
        line: '#30363d',
        accent: '#4A9EFF',
        ok: '#3DD68C',
        warn: '#E3B341',
        danger: '#FF4D4F',
      },
    },
  },
  plugins: [],
} satisfies Config;
