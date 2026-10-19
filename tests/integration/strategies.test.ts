import { beforeAll, beforeEach, afterAll, it, expect } from 'vitest';
import { loadEnvFile } from 'node:process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import {
  connectDatabase,
  users,
  accounts,
  tokens,
  strategyVersions,
  evaluations,
  configs,
  audits,
  bots,
} from '../../packages/database/src/index.js';
import { migrateDatabase } from '../../packages/database/src/migrate.js';
import { registerResearchStrategies } from '../../packages/database/src/strategies.js';
import { PostgresEvaluationRepository } from '../../packages/database/src/evaluations.js';
import { BotRepository, type Actor } from '../../packages/database/src/bots.js';
import { StrategyEngine } from '../../packages/strategies/src/engine.js';
import {
  trendFollowing,
  meanReversion,
} from '../../packages/strategies/src/research.js';
import { strategyInput } from '../fixtures/strategies.js';
import { market } from '../fixtures/market.js';
import { createApp } from '../../apps/api/src/app.js';
import { createLogger } from '../../packages/core/src/index.js';
try {
  loadEnvFile('.env');
} catch {
  /* explicit CI environment */
}
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test'))
  throw Error('Dedicated test DB required');
const { db, pool } = connectDatabase(url),
  botRepo = new BotRepository(db),
  repo = new PostgresEvaluationRepository(db),
  engine = new StrategyEngine(repo);
let actor: Actor,
  token: string,
  otherToken: string,
  registry: Awaited<ReturnType<typeof registerResearchStrategies>>;
let bot: Awaited<ReturnType<BotRepository['create']>>;
function input(
  scenario: 'trend-long' | 'trend-flat' | 'mean-flat' = 'trend-long',
) {
  return {
    ...strategyInput(scenario),
    botId: bot.id,
    accountId: bot.accountId,
    configVersion: bot.configVersion,
    strategyVersionId: bot.strategyVersionId,
    codeHash: registry.find((v) => v.slug === 'trend-following')!.codeHash,
  };
}
beforeAll(() => migrateDatabase(url));
afterAll(() => pool.end());
beforeEach(async () => {
  await pool.query(
    'TRUNCATE audit_events,bot_config_versions,coin_ownership,bots,api_tokens,exchange_accounts,strategy_versions,strategies,app_users CASCADE',
  );
  const [owner] = await db
    .insert(users)
    .values({ email: 'strategy-owner@fixture.local' })
    .returning();
  const [other] = await db
    .insert(users)
    .values({ email: 'strategy-other@fixture.local' })
    .returning();
  await db.insert(accounts).values([
    { ownerUserId: owner!.id, name: 'Strategy research' },
    { ownerUserId: other!.id, name: 'Foreign portfolio' },
  ]);
  actor = { userId: owner!.id, role: 'OWNER' };
  async function issue(userId: string) {
    const raw = randomBytes(32).toString('base64url');
    await db.insert(tokens).values({
      userId,
      tokenHash: createHash('sha256').update(raw).digest('hex'),
      role: 'OWNER',
      expiresAt: new Date(Date.now() + 60000),
    });
    return raw;
  }
  token = await issue(owner!.id);
  otherToken = await issue(other!.id);
  registry = await registerResearchStrategies(db);
  bot = await botRepo.create(
    actor,
    {
      name: 'Trend fixture',
      market,
      strategyVersionId: registry.find((v) => v.slug === 'trend-following')!.id,
      executionMode: 'PAPER',
      riskProfile: 'CONSERVATIVE',
      allocationTargetPercent: '20',
    },
    randomUUID(),
  );
});
it('registers immutable research versions idempotently without representing them as validated', async () => {
  const again = await registerResearchStrategies(db);
  expect(again).toEqual(registry);
  const versions = await db.select().from(strategyVersions);
  expect(versions).toHaveLength(2);
  expect(
    versions.every((v) => v.status === 'DRAFT' && v.codeHash?.length === 64),
  ).toBe(true);
  await expect(
    db.update(strategyVersions).set({ codeHash: 'b'.repeat(64) }),
  ).rejects.toThrow();
});
it('commits one immutable, versioned evaluation across concurrent duplicates and a fresh engine', async () => {
  const event = input();
  const [a, b] = await Promise.all([
    engine.evaluate(trendFollowing, event, randomUUID()),
    engine.evaluate(trendFollowing, event, randomUUID()),
  ]);
  expect(a.id).toBe(b.id);
  expect(a.decision).toBe('LONG');
  expect(await db.select().from(evaluations)).toHaveLength(1);
  const fresh = connectDatabase(url!);
  try {
    const restarted = new StrategyEngine(
      new PostgresEvaluationRepository(fresh.db),
    );
    const replay = await restarted.evaluate(
      trendFollowing,
      {
        ...event,
        trigger: {
          ...event.trigger,
          observedAt: event.trigger.observedAt + 1000,
        },
      },
      randomUUID(),
    );
    expect(replay.id).toBe(a.id);
    expect(replay.snapshot).toEqual(a.snapshot);
  } finally {
    await fresh.pool.end();
  }
  await expect(
    db.update(evaluations).set({ decision: 'NO_TRADE' }),
  ).rejects.toThrow();
  await expect(db.delete(evaluations)).rejects.toThrow();
});
it('NO_TRADE persists a reason and input evidence without modifying bot capital/configuration or creating extra audit actions', async () => {
  const before = await db.select().from(accounts);
  const r = await engine.evaluate(
    trendFollowing,
    input('trend-flat'),
    randomUUID(),
  );
  expect(r.decision).toBe('NO_TRADE');
  expect(r.reasonCode).toBe('WEAK_TREND');
  expect(r.snapshot.context.candles['15m']).toHaveLength(500);
  expect(await db.select().from(accounts)).toEqual(before);
  expect(await db.select().from(configs)).toHaveLength(1);
  expect(await db.select().from(audits)).toHaveLength(1);
  expect((await db.select().from(bots))[0]!.tradingState).toBe('IDLE');
});
it('rejects stale configurations, incorrect code hashes and a miswired strategy identity', async () => {
  await expect(
    engine.evaluate(
      trendFollowing,
      { ...input(), codeHash: 'b'.repeat(64) },
      randomUUID(),
    ),
  ).rejects.toThrow(/snapshot/);
  await expect(
    engine.evaluate(meanReversion, input('mean-flat'), randomUUID()),
  ).rejects.toThrow();
  const stale = input();
  await botRepo.update(
    actor,
    bot.id,
    {
      name: 'New config',
      expectedVersion: 1,
      reason: 'Stale evaluation fixture',
    },
    randomUUID(),
  );
  await expect(
    engine.evaluate(trendFollowing, stale, randomUUID()),
  ).rejects.toThrow(/configuration/);
  expect(await db.select().from(evaluations)).toHaveLength(0);
});
it('serves evaluation history only to its account and bounds retrieval size', async () => {
  const record = await engine.evaluate(trendFollowing, input(), randomUUID());
  const app = createApp(db, pool, createLogger('test', 'silent'));
  await request(app).get(`/api/bots/${bot.id}/evaluations`).expect(401);
  await request(app)
    .get(`/api/bots/${bot.id}/evaluations`)
    .set('Authorization', `Bearer ${otherToken}`)
    .expect(404);
  const r = await request(app)
    .get(`/api/bots/${bot.id}/evaluations`)
    .set('Authorization', `Bearer ${token}`)
    .expect(200);
  expect(r.body.data[0].id).toBe(record.id);
  expect(r.body.data[0].snapshot.strategy.codeHash).toBe(input().codeHash);
  expect(r.body.data[0].snapshot.context.candles).toBeUndefined();
  const detail = await request(app)
    .get(`/api/bots/${bot.id}/evaluations/${record.id}`)
    .set('Authorization', `Bearer ${token}`)
    .expect(200);
  expect(detail.body.data.snapshot.context.candles['15m']).toHaveLength(500);
  await request(app)
    .get(`/api/bots/${bot.id}/evaluations/${record.id}`)
    .set('Authorization', `Bearer ${otherToken}`)
    .expect(404);

  await request(app)
    .get(`/api/bots/${bot.id}/evaluations?limit=1000`)
    .set('Authorization', `Bearer ${token}`)
    .expect(400);
});
it('database rejects inconsistent snapshot metadata and cross-account attribution', async () => {
  await engine.evaluate(trendFollowing, input(), randomUUID());
  const [saved] = await db.select().from(evaluations);
  if (!saved) throw Error('Missing fixture');
  const { id, ...row } = saved;
  await expect(
    db.insert(evaluations).values({
      ...row,
      id: randomUUID(),
      triggerEventKey: 'forged',
      snapshot: { ...(row.snapshot as object), configVersion: 999 },
    }),
  ).rejects.toThrow();
  const all = await db.select().from(accounts);
  const foreign = all.find((a) => a.id !== bot.accountId)!;
  await expect(
    db.insert(evaluations).values({
      ...row,
      id: randomUUID(),
      accountId: foreign.id,
      triggerEventKey: 'foreign',
    }),
  ).rejects.toThrow();
  expect(await db.select().from(evaluations)).toHaveLength(1);
});
