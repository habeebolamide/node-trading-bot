/**
 * `npm run db:reset` — drops the public schema (everything: tables, triggers, functions) and
 * the drizzle migration journal, then re-runs every migration from `0000`. Meant for LOCAL DEV
 * ONLY — reads `DATABASE_URL` from the repo-root `.env` via `loadEnv()`.
 *
 * Never run this against a shared or production DB.
 */
import postgres from 'postgres';
import { loadEnv } from '@tip/domain';

loadEnv();

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set (checked env + repo-root .env)');
  process.exit(1);
}

const sql = postgres(url);
try {
  await sql.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public; DROP SCHEMA IF EXISTS drizzle CASCADE');
  console.log('wiped:', url.replace(/:\/\/[^@]*@/, '://***@'));
} finally {
  await sql.end();
}
