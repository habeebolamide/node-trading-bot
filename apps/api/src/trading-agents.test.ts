import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { createDb, closeDb, tradingAgent, scoringConfig, type Db } from '@tip/database';
import type { Redis } from 'ioredis';
import type { EventBus } from '@tip/events';
import { createApp } from './app.js';

const DATABASE_URL = process.env.DATABASE_URL;

function stubDeps(db: Db) {
  return {
    db,
    redis: { ping: vi.fn().mockResolvedValue('PONG') } as unknown as Redis,
    bus: { publish: vi.fn().mockResolvedValue({ id: 'e' }) } as unknown as EventBus,
    webhookSecret: 's',
  };
}

const validPerpBody = {
  name: 'API-Test',
  domain: 'perp',
  universe: ['BTCUSDT'],
  tradingStyle: 'day',
  config: {
    riskPercent: 0.01,
    minRR: 1.5,
    maxConcurrentPositions: 1,
    leverageMax: 10,
    agentWeights: { 'perp.momentum': 0.2 },
    signalThresholds: { strongLong: 0.7, long: 0.45, weakLong: 0.2, weakShort: -0.2, short: -0.45, strongShort: -0.7 },
  },
};

describe.skipIf(!DATABASE_URL)('/trading-agents (integration, Postgres)', () => {
  let db: Db;
  const created: string[] = [];

  beforeAll(() => { db = createDb(DATABASE_URL!); });
  afterAll(async () => {
    if (db) {
      for (const id of created) {
        await db.delete(scoringConfig).where(eq(scoringConfig.tradingAgentId, id));
        await db.delete(tradingAgent).where(eq(tradingAgent.id, id));
      }
      await closeDb(db);
    }
  });

  it('POST 201 → GET /:id round-trip → PATCH → GET returns v2', async () => {
    const app = createApp(stubDeps(db));
    const unique = { ...validPerpBody, name: `IT-${randomUUID().slice(0, 6)}` };
    const post = await request(app).post('/trading-agents').send(unique);
    expect(post.status).toBe(201);
    expect(post.body.activeConfigVersion).toBe(1);
    created.push(post.body.id);

    const get = await request(app).get(`/trading-agents/${post.body.id}`);
    expect(get.status).toBe(200);
    expect(get.body.name).toBe(unique.name);

    const patch = await request(app)
      .patch(`/trading-agents/${post.body.id}/config`)
      .send({ ...unique.config, riskPercent: 0.02 });
    expect(patch.status).toBe(200);
    expect(patch.body.activeConfigVersion).toBe(2);
    expect(patch.body.config.riskPercent).toBeCloseTo(0.02, 6);
  });

  it('POST 400 on bad body (missing tradingStyle)', async () => {
    const app = createApp(stubDeps(db));
    const bad = { ...validPerpBody, tradingStyle: 'bogus' };
    const res = await request(app).post('/trading-agents').send(bad);
    expect(res.status).toBe(400);
  });

  it('POST 400 when memecoin config violates §32 (maxConcurrentPositions != 1)', async () => {
    const app = createApp(stubDeps(db));
    const bad = {
      name: `IT-${randomUUID().slice(0, 6)}`,
      domain: 'memecoin',
      universe: ['solana'],
      tradingStyle: 'scalp',
      config: {
        riskPercent: 0.02,
        minRR: 0,
        maxConcurrentPositions: 5, // violates §32
        agentWeights: {},
        signalThresholds: { strongLong: 0.7, long: 0.45, weakLong: 0.2 },
      },
    };
    const res = await request(app).post('/trading-agents').send(bad);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/maxConcurrentPositions/);
  });

  it('GET /:id 404 for unknown id', async () => {
    const app = createApp(stubDeps(db));
    const res = await request(app).get('/trading-agents/does-not-exist');
    expect(res.status).toBe(404);
  });
});
