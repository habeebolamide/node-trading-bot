import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { getConfig } from '@tip/domain';
import { schema } from './schema.js';

export type Db = PostgresJsDatabase<typeof schema>;

/**
 * Build a Drizzle client over a given Postgres URL. `prepare: false` because the
 * runtime connection is the pooled (pgBouncer transaction-mode) URL, where
 * server-side prepared statements don't survive across pooled connections.
 * Callers own the returned client's lifecycle via {@link closeDb}.
 */
export function createDb(url: string): Db {
  const sql = postgres(url, {
    prepare: false,
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10, // every I/O call has a timeout (CLAUDE.md)
  });
  const db = drizzle(sql, { schema });
  clients.set(db, sql);
  return db;
}

const clients = new WeakMap<Db, ReturnType<typeof postgres>>();

/** Close the underlying connection pool for a client created by {@link createDb}. */
export async function closeDb(db: Db): Promise<void> {
  const sql = clients.get(db);
  if (sql) await sql.end({ timeout: 5 });
}

let cached: Db | undefined;

/** Process-wide client over the pooled `DATABASE_URL`. Lazily created at first use. */
export function getDb(): Db {
  cached ??= createDb(getConfig().DATABASE_URL);
  return cached;
}
