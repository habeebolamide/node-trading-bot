import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import { fileURLToPath } from 'node:url';
import { connectDatabase } from './index.js';
export const migrationsFolder = fileURLToPath(
  new URL('../migrations', import.meta.url),
);
export async function migrateDatabase(url: string, folder = migrationsFolder) {
  const { pool } = connectDatabase(url);
  const client = await pool.connect();
  let locked = false;
  try {
    await client.query(
      "SELECT pg_advisory_lock(hashtext(current_database()),hashtext('platform-migrations'))",
    );
    locked = true;
    const files = readMigrationFiles({ migrationsFolder: folder });
    const exists = await client.query(
      "SELECT to_regclass('drizzle.__drizzle_migrations') AS relation",
    );
    if (exists.rows[0].relation) {
      const applied = await client.query(
        'SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY created_at,id',
      );
      for (const [i, row] of applied.rows.entries()) {
        const file = files[i];
        if (
          !file ||
          file.folderMillis !== Number(row.created_at) ||
          file.hash !== row.hash
        )
          throw Error(
            'MIGRATION_HISTORY_MISMATCH: restore the exact applied migration files; no changes were applied',
          );
      }
    }
    // One physical connection owns the advisory lock and the transactional Drizzle migration.
    await migrate(drizzle(client), { migrationsFolder: folder });
  } finally {
    try {
      if (locked)
        await client.query(
          "SELECT pg_advisory_unlock(hashtext(current_database()),hashtext('platform-migrations'))",
        );
    } finally {
      client.release();
      await pool.end();
    }
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  await migrateDatabase(process.env.DATABASE_URL);
  console.log('Migrations applied');
}
