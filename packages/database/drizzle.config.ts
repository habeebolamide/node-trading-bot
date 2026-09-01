import { config as loadDotenv } from 'dotenv';
import { defineConfig } from 'drizzle-kit';

// Migrations use the DIRECT (non-pooled) URL. Load the repo-root .env relative to
// this workspace dir (npm runs workspace scripts with cwd = the workspace).
loadDotenv({ path: '../../.env' });

const url = process.env.DIRECT_URL;
if (!url) throw new Error('DIRECT_URL is required to run migrations (see .env.example)');

export default defineConfig({
  schema: './src/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
