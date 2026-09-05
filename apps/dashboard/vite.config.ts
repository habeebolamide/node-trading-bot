import { defineConfig } from 'vite';
import { config as loadDotenv } from 'dotenv';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Load DASHBOARD_API_URL / API_PORT from the repo-root .env so the operator edits ONE file.
// Vite normally only loads its own .env files under apps/dashboard/, but that's a second place
// to keep in sync — worse.
loadDotenv({ path: path.resolve(__dirname, '../../.env') });

// Prefer DASHBOARD_API_URL (explicit URL), else derive from API_PORT (source of truth in .env),
// else hardcoded fallback. Bug found 2026-09-05: the fallback used to be :8000, but .env sets
// API_PORT=5919, so every dashboard fetch was 500'ing (proxy to a dead port).
const API_TARGET = process.env.DASHBOARD_API_URL
  ?? (process.env.API_PORT ? `http://localhost:${process.env.API_PORT}` : 'http://localhost:8000');

// The dashboard is a static SPA hitting the API at DASHBOARD_API_URL (defaults to same-origin
// /api). No SSR in MVP — a Vite build produces a bundle any static host can serve, and Nginx
// or a simple Express static handler in front proxies /api to the api workspace.
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
      '/trading-agents': { target: API_TARGET, changeOrigin: true },
      '/ws': { target: API_TARGET.replace('http', 'ws'), ws: true, changeOrigin: true },
    },
  },
});
