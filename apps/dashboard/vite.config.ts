import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// The dashboard is a static SPA hitting the API at DASHBOARD_API_URL (defaults to same-origin
// /api). No SSR in MVP — a Vite build produces a bundle any static host can serve, and Nginx
// or a simple Express static handler in front proxies /api to the api workspace.
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: process.env.DASHBOARD_API_URL ?? 'http://localhost:3000', changeOrigin: true },
      '/ws': { target: (process.env.DASHBOARD_API_URL ?? 'http://localhost:3000').replace('http', 'ws'), ws: true, changeOrigin: true },
    },
  },
});
