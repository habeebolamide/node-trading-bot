import { it, expect } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { loadEnvFile } from 'node:process';
import { once } from 'node:events';
import { randomBytes, createHash } from 'node:crypto';
import {
  connectDatabase,
  users,
  accounts,
  tokens,
  strategies,
  strategyVersions,
} from '../../packages/database/src/index.js';
import { migrateDatabase } from '../../packages/database/src/migrate.js';
try {
  loadEnvFile('.env');
} catch {
  /* explicit CI environment */
}
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test'))
  throw new Error('Dedicated TEST_DATABASE_URL required');
const children: ChildProcess[] = [];
async function launch(file: string, port: number) {
  let output = '';
  const child = spawn(process.execPath, ['--import', 'tsx', file], {
    env: {
      ...process.env,
      DATABASE_URL: url!,
      API_PORT: '43430',
      RUNTIME_HEALTH_PORT: '43431',
      WORKER_HEALTH_PORT: '43432',
      LOG_LEVEL: 'silent',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  child.stdout?.on('data', (d) => {
    output = (output + d).slice(-3000);
  });
  child.stderr?.on('data', (d) => {
    output = (output + d).slice(-3000);
  });
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) throw new Error(`Process exited: ${output}`);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health/live`, {
        signal: AbortSignal.timeout(500),
      });
      if (r.ok) return child;
    } catch {
      /* wait for bind */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Process startup timeout: ${output}`);
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}
it('API restart preserves stored config and leaves runtime/worker processes alive', async () => {
  const { db, pool } = connectDatabase(url!);
  try {
    await migrateDatabase(url!);
    const suffix = randomBytes(5).toString('hex');
    const [owner] = await db
      .insert(users)
      .values({ email: `process-${suffix}@test.local` })
      .returning();
    await db
      .insert(accounts)
      .values({ ownerUserId: owner!.id, name: 'Process test' });
    const raw = randomBytes(32).toString('base64url');
    await db.insert(tokens).values({
      userId: owner!.id,
      tokenHash: createHash('sha256').update(raw).digest('hex'),
      role: 'OWNER',
      expiresAt: new Date(Date.now() + 60000),
    });
    const [s] = await db
      .insert(strategies)
      .values({ slug: `process-${suffix}`, name: 'Process fixture' })
      .returning();
    const [v] = await db
      .insert(strategyVersions)
      .values({
        strategyId: s!.id,
        version: '0.0.0',
        requirements: { implemented: false },
      })
      .returning();
    const runtime = await launch('apps/runtime/src/main.ts', 43431);
    const worker = await launch('apps/worker/src/main.ts', 43432);
    const api = await launch('apps/api/src/main.ts', 43430);
    const created = await fetch('http://127.0.0.1:43430/api/bots', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${raw}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Restart test',
        market: {
          exchange: 'bybit',
          marketType: 'SPOT',
          baseAsset: `T${suffix.toUpperCase()}`,
          quoteAsset: 'USDT',
        },
        strategyVersionId: v!.id,
      }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { data: { id: string } };
    await stop(api);
    expect(runtime.exitCode).toBeNull();
    expect(worker.exitCode).toBeNull();
    expect((await fetch('http://127.0.0.1:43431/health/live')).status).toBe(
      200,
    );
    expect((await fetch('http://127.0.0.1:43432/health/live')).status).toBe(
      200,
    );
    expect((await fetch('http://127.0.0.1:43431/health/ready')).status).toBe(
      503,
    );
    await launch('apps/api/src/main.ts', 43430);
    const restored = await fetch(
      `http://127.0.0.1:43430/api/bots/${body.data.id}`,
      { headers: { Authorization: `Bearer ${raw}` } },
    );
    expect(restored.status).toBe(200);
    expect(
      ((await restored.json()) as { data: { name: string } }).data.name,
    ).toBe('Restart test');
  } finally {
    await Promise.all(children.map(stop));
    await pool.end();
  }
}, 30000);
