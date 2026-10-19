import { defineConfig } from 'vite';
const proxy = {
  '/api': 'http://127.0.0.1:3000',
  '/health': 'http://127.0.0.1:3000',
};
export default defineConfig({ server: { proxy }, preview: { proxy } });
