import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { loadEnvFile } from 'node:process';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import {
  connectDatabase,
  users,
  accounts,
  tokens,
  strategies,
  strategyVersions,
  bots,
  configs,
  audits,
  ownership,
} from '../../packages/database/src/index.js';
import { migrateDatabase } from '../../packages/database/src/migrate.js';
import { createApp } from '../../apps/api/src/app.js';
import { createLogger } from '../../packages/core/src/index.js';
try {
  loadEnvFile('.env');
} catch {
  /* CI supplies explicit environment */
}
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test'))
  throw new Error(
    'TEST_DATABASE_URL must name a dedicated database ending in _test',
  );
const { db, pool } = connectDatabase(url);
let token: string,
  viewer: string,
  other: string,
  strategyId: string,
  accountId: string;
let app: ReturnType<typeof createApp>;
const auth = () => `Bearer ${token}`;
const input = (coin = 'BTC', allocation = '20') => ({
  name: `${coin} research`,
  market: {
    exchange: 'bybit',
    marketType: 'LINEAR_PERPETUAL',
    baseAsset: coin,
    quoteAsset: 'USDT',
  },
  strategyVersionId: strategyId,
  allocationTargetPercent: allocation,
});
async function issue(userId: string, role: 'OWNER' | 'VIEWER') {
  const raw = randomBytes(32).toString('base64url');
  await db.insert(tokens).values({
    userId,
    role,
    tokenHash: createHash('sha256').update(raw).digest('hex'),
    expiresAt: new Date(Date.now() + 60000),
  });
  return raw;
}
beforeAll(async () => {
  await migrateDatabase(url);
  await migrateDatabase(url);
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  // Deliberately isolated test DB; no dev/production data is touched.
  await pool.query(
    'TRUNCATE audit_events, bot_config_versions, coin_ownership, bots, api_tokens, exchange_accounts, strategy_versions, strategies, app_users CASCADE',
  );
  const [owner] = await db
    .insert(users)
    .values({ email: 'owner@test.local' })
    .returning();
  const [foreign] = await db
    .insert(users)
    .values({ email: 'other@test.local' })
    .returning();
  const [account] = await db
    .insert(accounts)
    .values({
      ownerUserId: owner!.id,
      name: 'Paper test',
      equityBaseline: '100',
    })
    .returning();
  await db
    .insert(accounts)
    .values({ ownerUserId: foreign!.id, name: 'Other portfolio' });
  accountId = account!.id;
  token = await issue(owner!.id, 'OWNER');
  viewer = await issue(owner!.id, 'VIEWER');
  other = await issue(foreign!.id, 'OWNER');
  const [s] = await db
    .insert(strategies)
    .values({ slug: 'research', name: 'Research fixture' })
    .returning();
  const [v] = await db
    .insert(strategyVersions)
    .values({
      strategyId: s!.id,
      version: '0.0.0',
      requirements: { implemented: false },
    })
    .returning();
  strategyId = v!.id;
  app = createApp(db, pool, createLogger('test', 'silent'));
});
describe('real PostgreSQL API and domain integrity', () => {
  it('creates a stopped PAPER bot, versions changes, persists through API recreation', async () => {
    const created = await request(app)
      .post('/api/bots')
      .set('Authorization', auth())
      .send(input())
      .expect(201);
    expect(created.body.data).toMatchObject({
      operationalStatus: 'STOPPED',
      tradingState: 'IDLE',
      executionMode: 'PAPER',
      configVersion: 1,
    });
    const id = created.body.data.id;
    await request(app)
      .patch(`/api/bots/${id}`)
      .set('Authorization', auth())
      .send({ name: 'Updated research', expectedVersion: 1, reason: 'Rename' })
      .expect(200);
    await request(app)
      .patch(`/api/bots/${id}`)
      .set('Authorization', auth())
      .send({ name: 'Stale write', expectedVersion: 1, reason: 'Race' })
      .expect(409);
    const fresh = connectDatabase(url!);
    try {
      const restarted = createApp(
        fresh.db,
        fresh.pool,
        createLogger('test', 'silent'),
      );
      const fetched = await request(restarted)
        .get(`/api/bots/${id}`)
        .set('Authorization', auth())
        .expect(200);
      expect(fetched.body.data.name).toBe('Updated research');
      const history = await request(restarted)
        .get(`/api/bots/${id}/config-versions`)
        .set('Authorization', auth())
        .expect(200);
      expect(
        history.body.data.map(
          (v: { configVersion: number }) => v.configVersion,
        ),
      ).toEqual([1, 2]);
    } finally {
      await fresh.pool.end();
    }
    expect(await db.select().from(audits)).toHaveLength(2);
  });
  it('rejects simultaneous canonical coin claims across aliases and market types', async () => {
    const a = input('btc'),
      b = {
        ...input('XBT'),
        market: { ...input('XBT').market, marketType: 'SPOT' },
      };
    const result = await Promise.all(
      [a, b].map((v) =>
        request(app).post('/api/bots').set('Authorization', auth()).send(v),
      ),
    );
    expect(result.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await db.select().from(bots)).toHaveLength(1);
    expect(await db.select().from(configs)).toHaveLength(1);
    expect(await db.select().from(ownership)).toHaveLength(1);
  });
  it('serializes competing account allocations and enforces 80% in PostgreSQL', async () => {
    const result = await Promise.all(
      ['BTC', 'ETH'].map((c) =>
        request(app)
          .post('/api/bots')
          .set('Authorization', auth())
          .send(input(c, '50')),
      ),
    );
    expect(result.map((r) => r.status).sort()).toEqual([201, 409]);
    const rows = await db.select().from(bots);
    expect(rows).toHaveLength(1);
    await expect(
      db
        .update(bots)
        .set({ allocationTargetPercent: '81' })
        .where(eq(bots.id, rows[0]!.id)),
    ).rejects.toThrow();
  });
  it('rejects concurrent updates exceeding total allocation and rolls back failed history', async () => {
    const a = await request(app)
      .post('/api/bots')
      .set('Authorization', auth())
      .send(input('BTC', '30'));
    const b = await request(app)
      .post('/api/bots')
      .set('Authorization', auth())
      .send(input('ETH', '30'));
    const result = await Promise.all(
      [a, b].map((r) =>
        request(app)
          .patch(`/api/bots/${r.body.data.id}`)
          .set('Authorization', auth())
          .send({
            allocationTargetPercent: '50',
            expectedVersion: 1,
            reason: 'Allocation change',
          }),
      ),
    );
    expect(result.map((r) => r.status).sort()).toEqual([200, 409]);
    const rows = await db.select().from(bots);
    expect(
      rows.reduce((s, b) => s + Number(b.allocationTargetPercent), 0),
    ).toBe(80);
    expect(await db.select().from(configs)).toHaveLength(3);
  });
  it('requires authentication, enforces roles and account isolation', async () => {
    await request(app).get('/api/bots').expect(401);
    await request(app)
      .post('/api/bots')
      .set('Authorization', `Bearer ${viewer}`)
      .send(input())
      .expect(403);
    const r = await request(app)
      .post('/api/bots')
      .set('Authorization', auth())
      .send(input())
      .expect(201);
    await request(app)
      .get(`/api/bots/${r.body.data.id}`)
      .set('Authorization', `Bearer ${other}`)
      .expect(404);
    const list = await request(app)
      .get('/api/bots')
      .set('Authorization', `Bearer ${other}`)
      .expect(200);
    expect(list.body.data).toEqual([]);
    await db
      .update(tokens)
      .set({ revokedAt: new Date() })
      .where(
        eq(tokens.tokenHash, createHash('sha256').update(token).digest('hex')),
      );
    await request(app)
      .get('/api/bots')
      .set('Authorization', auth())
      .expect(401);
  });
  it('rejects live mode, malformed IDs, missing strategy and signal-only capital', async () => {
    await request(app)
      .post('/api/bots')
      .set('Authorization', auth())
      .send({ ...input(), executionMode: 'LIVE' })
      .expect(400);
    await request(app)
      .post('/api/bots')
      .set('Authorization', auth())
      .send({ ...input(), executionMode: 'SIGNAL_ONLY' })
      .expect(400);
    await request(app)
      .post('/api/bots')
      .set('Authorization', auth())
      .send({ ...input(), strategyVersionId: randomUUID() })
      .expect(404);
    await request(app)
      .get('/api/bots/bad-id')
      .set('Authorization', auth())
      .expect(400);
    expect(await db.select().from(bots)).toHaveLength(0);
  });
  it('protects immutable configuration, audit and strategy history', async () => {
    await request(app)
      .post('/api/bots')
      .set('Authorization', auth())
      .send(input())
      .expect(201);
    await expect(
      db.update(configs).set({ reason: 'tamper' }),
    ).rejects.toThrow();
    await expect(db.delete(audits)).rejects.toThrow();
    await expect(
      db.update(strategyVersions).set({ version: 'rewritten' }),
    ).rejects.toThrow();
    await expect(db.delete(ownership)).rejects.toThrow();
  });
  it('reports liveness/readiness and creates correlation IDs', async () => {
    const r = await request(app)
      .get('/health/live')
      .set('X-Correlation-ID', 'untrusted text')
      .expect(200);
    expect(r.headers['x-correlation-id']).toMatch(/^[a-f0-9-]{36}$/);
    await request(app).get('/health/ready').expect(200);
  });
  it('database disallows phantom running/live states', async () => {
    const r = await request(app)
      .post('/api/bots')
      .set('Authorization', auth())
      .send(input())
      .expect(201);
    await expect(
      db
        .update(bots)
        .set({ executionMode: 'LIVE' })
        .where(eq(bots.id, r.body.data.id)),
    ).rejects.toThrow();
    await expect(
      db
        .update(bots)
        .set({ operationalStatus: 'RUNNING' })
        .where(eq(bots.id, r.body.data.id)),
    ).rejects.toThrow();
  });
});
