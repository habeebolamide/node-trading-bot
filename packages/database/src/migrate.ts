import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import { connectDatabase } from './index.js';
export async function migrateDatabase(url: string) {
  const { pool, db } = connectDatabase(url);
  try {
    await migrate(db, {
      migrationsFolder: fileURLToPath(
        new URL('../migrations', import.meta.url),
      ),
    });
  } finally {
    await pool.end();
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  await migrateDatabase(process.env.DATABASE_URL);
  console.log('Migrations applied');
}
