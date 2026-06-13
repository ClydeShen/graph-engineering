import type { Config } from 'tailwindcss';

// Memex observatory theme: colors come from CSS custom properties in
// src/styles/tokens/ (see globals.css); components reference them directly
// via var(--token) rather than Tailwind color utilities.
export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {},
  },
  plugins: [],
} satisfies Config;
