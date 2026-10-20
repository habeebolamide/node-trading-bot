import { verifyFinancialIntegrity } from './integrity.js';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, createReadStream } from 'node:fs';
import { stat, open, link, unlink, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { connectDatabase } from '../../database/src/index.js';
export function pgEnvironment(url: string) {
  const parsed = new URL(url);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol))
    throw Error('PostgreSQL URL required');
  if (
    !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$/.test(
      decodeURIComponent(parsed.pathname.slice(1)),
    )
  )
    throw Error('A plain PostgreSQL database name is required');
  for (const key of parsed.searchParams.keys())
    if (!['sslmode'].includes(key))
      throw Error('Backup URLs support only sslmode query options');
  if (
    !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(parsed.hostname) &&
    parsed.searchParams.get('sslmode') !== 'verify-full'
  )
    throw Error(
      'Remote PostgreSQL backup connections require sslmode=verify-full',
    );
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !key.startsWith('PG') ||
          ['PGSSLROOTCERT', 'PGSSLCERT', 'PGSSLKEY', 'PGSSLCRL'].includes(key),
      ),
    ),
    PGHOST: parsed.hostname.replace(/^\[|\]$/g, ''),
    PGPORT: parsed.port || '5432',
    PGUSER: decodeURIComponent(parsed.username),
    PGPASSWORD: decodeURIComponent(parsed.password),
    PGDATABASE: decodeURIComponent(parsed.pathname.slice(1)),
    PGSSLMODE: parsed.searchParams.get('sslmode') ?? 'prefer',
    PGCONNECT_TIMEOUT: '5',
  };
}
async function hash(path: string) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return h.digest('hex');
}
export async function pgTool(name: string, args: string[], url: string) {
  const directory =
    process.env.PG_BIN_DIR ??
    (process.platform === 'darwin' && existsSync('/Library/PostgreSQL/17/bin')
      ? '/Library/PostgreSQL/17/bin'
      : undefined);
  const binary = directory ? join(directory, name) : name;
  await new Promise<void>((resolve, reject) => {
    // Credentials are environment-only; do not echo utility stderr or connection URLs.
    const child = spawn(binary, args, {
      env: pgEnvironment(url),
      stdio: 'ignore',
    });
    child.on('error', () =>
      reject(Error(`${name} unavailable; configure PG_BIN_DIR`)),
    );
    child.on('exit', (code) =>
      code === 0
        ? resolve()
        : reject(
            Error(
              `${name} failed (exit ${code}); inspect the private PostgreSQL server log`,
            ),
          ),
    );
  });
}
export async function backupDatabase(url: string, output: string) {
  const path = resolve(output),
    partial = path + '.partial',
    manifestPath = path + '.manifest.json';
  if ((await stat(dirname(path))).mode & 0o077)
    throw Error('Backup directory must be private (chmod 700)');
  const file = await open(partial, 'wx', 0o600);
  await file.close();
  try {
    await pgTool(
      'pg_dump',
      ['--format=custom', '--no-owner', '--no-acl', '--file', partial],
      url,
    );
    const archiveFile = await open(partial, 'r');
    try {
      await archiveFile.sync();
    } finally {
      await archiveFile.close();
    }
    const info = await stat(partial),
      manifest = {
        version: 'paper-backup-v1',
        createdAt: new Date().toISOString(),
        bytes: info.size,
        sha256: await hash(partial),
      };
    // Hard-link publication refuses to replace an existing archive, including symlinks.
    await link(partial, path);
    const manifestFile = await open(manifestPath, 'wx', 0o600);
    try {
      await manifestFile.writeFile(JSON.stringify(manifest, null, 2) + '\n');
      await manifestFile.sync();
    } finally {
      await manifestFile.close();
    }
    const directory = await open(dirname(path), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    return manifest;
  } finally {
    await unlink(partial).catch(() => {});
  }
}
export async function restoreDatabase(
  url: string,
  input: string,
  confirmedDatabase: string,
) {
  const path = resolve(input),
    env = pgEnvironment(url);
  if (!confirmedDatabase || env.PGDATABASE !== confirmedDatabase)
    throw Error('Target database confirmation does not match');
  const manifest = JSON.parse(
    await readFile(path + '.manifest.json', 'utf8'),
  ) as { version: string; bytes: number; sha256: string };
  if (
    manifest.version !== 'paper-backup-v1' ||
    manifest.bytes !== (await stat(path)).size ||
    manifest.sha256 !== (await hash(path))
  )
    throw Error('Backup checksum or manifest invalid');
  const { pool } = connectDatabase(url);
  try {
    const tables = await pool.query(
      `SELECT 1 FROM pg_namespace n WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND
 (EXISTS(SELECT 1 FROM pg_class c WHERE c.relnamespace=n.oid) OR EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace=n.oid) OR EXISTS(SELECT 1 FROM pg_type t WHERE t.typnamespace=n.oid) OR n.nspname<>'public') LIMIT 1`,
    );
    if (tables.rowCount)
      throw Error(
        'Restore target must be an empty, isolated database; existing data will not be overwritten',
      );
    const clients = await pool.query(
      'SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()',
    );
    if (clients.rowCount)
      throw Error('Restore target has other sessions; stop all services first');
  } finally {
    await pool.end();
  }
  await pgTool(
    'pg_restore',
    [
      '--single-transaction',
      '--exit-on-error',
      '--no-owner',
      '--no-acl',
      '--dbname',
      env.PGDATABASE,
      path,
    ],
    url,
  );
  const restored = connectDatabase(url);
  try {
    await verifyFinancialIntegrity(restored.pool);
    await restored.pool.query(`BEGIN;
 UPDATE runtime_leases SET fencing_token=fencing_token+1,expires_at=clock_timestamp()-interval '1 second';
 UPDATE replay_runs SET lease_until=clock_timestamp()-interval '1 second' WHERE status='RUNNING';
 UPDATE notification_outbox SET lease_until=clock_timestamp()-interval '1 second' WHERE status='SENDING';
 COMMIT;`);
  } finally {
    await restored.pool.end();
  }
}
