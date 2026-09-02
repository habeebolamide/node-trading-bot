import type { Config } from 'tailwindcss';
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        accent: {
          DEFAULT: '#22d3ee',
          muted: '#164e63',
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
