import { beforeAll, afterAll, it, expect } from 'vitest';
import { loadEnvFile } from 'node:process';
import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { connectDatabase } from '../../packages/database/src/index.js';
import {
  migrateDatabase,
  migrationsFolder,
} from '../../packages/database/src/migrate.js';
try {
  loadEnvFile('.env');
} catch {}
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test'))
  throw Error('Dedicated test DB required');
const { pool, db } = connectDatabase(url);
beforeAll(() => migrateDatabase(url));
afterAll(() => pool.end());
it('serializes concurrent migrators and rejects changed applied checksums before database writes', async () => {
  await Promise.all([migrateDatabase(url!), migrateDatabase(url!)]);
  const before = (
    await pool.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY id')
  ).rows;
  const dir = await mkdtemp(join(tmpdir(), 'paper-migration-'));
  try {
    await cp(migrationsFolder, dir, { recursive: true });
    const journal = JSON.parse(
      await readFile(join(dir, 'meta/_journal.json'), 'utf8'),
    );
    const first = journal.entries[0];
    const path = join(dir, first.tag + '.sql');
    await writeFile(
      path,
      (await readFile(path, 'utf8')) + '\n-- changed historical source\n',
    );
    await expect(migrateDatabase(url!, dir)).rejects.toThrow(
      'MIGRATION_HISTORY_MISMATCH',
    );
    expect(
      (
        await pool.query(
          'SELECT * FROM drizzle.__drizzle_migrations ORDER BY id',
        )
      ).rows,
    ).toEqual(before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it('rolls back partially executed migration DDL and never advances the journal after a bad migration', async () => {
  const before = (
      await pool.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY id')
    ).rows,
    dir = await mkdtemp(join(tmpdir(), 'paper-bad-migration-'));
  try {
    await cp(migrationsFolder, dir, { recursive: true });
    const path = join(dir, 'meta/_journal.json'),
      journal = JSON.parse(await readFile(path, 'utf8')),
      last = journal.entries.at(-1);
    journal.entries.push({
      ...last,
      idx: last.idx + 1,
      when: last.when + 1,
      tag: '9999_failure_fixture',
    });
    await writeFile(path, JSON.stringify(journal));
    await writeFile(
      join(dir, '9999_failure_fixture.sql'),
      'CREATE TABLE phase8_rollback_fixture(id integer);\n--> statement-breakpoint\nSELECT phase8_nonexistent_function();',
    );
    await expect(migrateDatabase(url!, dir)).rejects.toThrow();
    expect(
      (
        await pool.query(
          "SELECT to_regclass('public.phase8_rollback_fixture') AS table_name",
        )
      ).rows[0].table_name,
    ).toBeNull();
    expect(
      (
        await pool.query(
          'SELECT * FROM drizzle.__drizzle_migrations ORDER BY id',
        )
      ).rows,
    ).toEqual(before);
    await migrateDatabase(url!);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it('issues private viewer tokens, refuses file overwrites, audits issuance/revocation and rejects revoked access', async () => {
  const { execFile } = await import('node:child_process'),
    { promisify } = await import('node:util'),
    { stat } = await import('node:fs/promises'),
    { randomUUID } = await import('node:crypto');
  const request = (await import('supertest')).default,
    { createApp } = await import('../../apps/api/src/app.js'),
    { createLogger } = await import('../../packages/core/src/index.js');
  const user = (
    await pool.query('INSERT INTO app_users(email) VALUES($1) RETURNING *', [
      `ops-${randomUUID()}@fixture.local`,
    ])
  ).rows[0];
  await pool.query(
    'INSERT INTO exchange_accounts(owner_user_id,name) VALUES($1,$2)',
    [user.id, 'Synthetic token operations'],
  );
  const dir = await mkdtemp(join(tmpdir(), 'private-token-')),
    file = join(dir, 'viewer.txt'),
    run = promisify(execFile),
    base = [
      '--import',
      'tsx',
      'scripts/tokens.ts',
      '--owner',
      user.email,
      '--reason',
      'Synthetic access review',
    ];
  try {
    const issued = await run(
      process.execPath,
      [...base, '--action', 'issue', '--role', 'VIEWER', '--out', file],
      { env: { ...process.env, DATABASE_URL: url! } },
    );
    const raw = (await readFile(file, 'utf8')).trim();
    expect(issued.stdout).not.toContain(raw);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const app = createApp(db, pool, createLogger('test', 'silent'));
    await request(app)
      .get('/api/session')
      .set('Authorization', 'Bearer ' + raw)
      .expect(200);
    await request(app)
      .post('/api/bots')
      .set('Authorization', 'Bearer ' + raw)
      .send({})
      .expect(403);
    await expect(
      run(process.execPath, [...base, '--action', 'issue', '--out', file], {
        env: { ...process.env, DATABASE_URL: url! },
      }),
    ).rejects.toThrow();
    expect(
      (
        await pool.query(
          'SELECT count(*)::int AS count FROM api_tokens WHERE user_id=$1',
          [user.id],
        )
      ).rows[0].count,
    ).toBe(1);
    const token = (
      await pool.query('SELECT id FROM api_tokens WHERE user_id=$1', [user.id])
    ).rows[0];
    await run(
      process.execPath,
      [...base, '--action', 'revoke', '--token-id', token.id],
      { env: { ...process.env, DATABASE_URL: url! } },
    );
    await request(app)
      .get('/api/session')
      .set('Authorization', 'Bearer ' + raw)
      .expect(401);
    const audits = (
      await pool.query(
        "SELECT event_type,details FROM audit_events WHERE actor_id=$1 AND event_type LIKE 'security.token.%' ORDER BY created_at",
        [user.id],
      )
    ).rows;
    expect(audits.map((a) => a.event_type)).toEqual([
      'security.token.issue',
      'security.token.revoke',
    ]);
    expect(JSON.stringify(audits)).not.toContain(raw);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
