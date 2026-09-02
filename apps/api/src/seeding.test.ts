import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { Redis } from 'ioredis';
import { eq } from 'drizzle-orm';
import { createDb, closeDb, scoringConfig, tradingAgent, type Db } from '@tip/database';
import { createTradingAgent } from '@tip/trading-agents';
import type { EventBus } from '@tip/events';
import { createApp } from './app.js';
import { clearSeedJobsForTests } from './seeding.js';

const DATABASE_URL = process.env.DATABASE_URL;

const PERP_CFG = {
  riskPercent: 0.01, minRR: 1.5, maxConcurrentPositions: 1, leverageMax: 10,
  agentWeights: { 'perp.momentum': 1 },
  confidenceWeights: { signalStrength: 0.3, agentAgreement: 0.3, historicalEvidence: 0.25, dataQuality: 0.15 },
  signalThresholds: { strongLong: 0.7, long: 0.45, weakLong: 0.2, weakShort: -0.2, short: -0.45, strongShort: -0.7 },
};
const MEME_CFG = {
  riskPercent: 0.02, minRR: 0, maxConcurrentPositions: 1,
  agentWeights: { 'memecoin.smart_money': 1 },
  confidenceWeights: { signalStrength: 0.3, agentAgreement: 0.3, historicalEvidence: 0.25, dataQuality: 0.15 },
  signalThresholds: { strongLong: 0.7, long: 0.45, weakLong: 0.2, weakShort: -0.2, short: -0.45, strongShort: -0.7 },
  stopPct: 0.3,
};

describe.skipIf(!DATABASE_URL)('seeding routes (§25 dashboard flow)', () => {
  let db: Db;
  let app: Express;
  const created: string[] = [];

  beforeAll(async () => {
    db = createDb(DATABASE_URL!);
    const fakeRedis = { ping: vi.fn(async () => 'PONG') } as unknown as Redis;
    const fakeBus = { publish: vi.fn(async () => ({ id: 'e' })) } as unknown as EventBus;
    app = createApp({ db, redis: fakeRedis, bus: fakeBus, webhookSecret: undefined });
  });
  beforeEach(() => clearSeedJobsForTests());
  afterAll(async () => {
    if (db) {
      for (const id of created) {
        await db.delete(scoringConfig).where(eq(scoringConfig.tradingAgentId, id));
        await db.delete(tradingAgent).where(eq(tradingAgent.id, id));
      }
      await closeDb(db);
    }
  });

  async function makeAgent(domain: 'perp' | 'memecoin', symbol: string): Promise<string> {
    const a = await createTradingAgent(db, {
      name: `SEED-${randomUUID().slice(0, 6)}`, domain,
      universe: [symbol], tradingStyle: domain === 'perp' ? 'day' : 'scalp',
      config: domain === 'perp' ? PERP_CFG : MEME_CFG,
    });
    created.push(a.id);
    return a.id;
  }

  it("POST /seed for a symbol with no candles → 400 'No backfill for this token' (operator contract)", async () => {
    const id = await makeAgent('perp', `NOFILL${randomUUID().slice(0, 4).toUpperCase()}USDT`);
    const r = await request(app).post(`/trading-agents/${id}/seed`).send({});
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('No backfill for this token');
  });

  it('POST /seed for a memecoin agent → 400 (§25: no historical seeding)', async () => {
    const id = await makeAgent('memecoin', 'solana');
    const r = await request(app).post(`/trading-agents/${id}/seed`).send({});
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('§25');
  });

  it('GET /seeding/status returns per-agent map; a never-seeded agent is absent or unseeded', async () => {
    const id = await makeAgent('perp', `STAT${randomUUID().slice(0, 4).toUpperCase()}USDT`);
    const r = await request(app).get('/trading-agents/seeding/status');
    expect(r.status).toBe(200);
    const st = r.body.statuses[id];
    expect(st === undefined || (st.seeded === false && st.running === false)).toBe(true);
  });

  it('GET /:id/seed/status reports unseeded for a fresh agent', async () => {
    const id = await makeAgent('perp', `FRESH${randomUUID().slice(0, 4).toUpperCase()}USDT`);
    const r = await request(app).get(`/trading-agents/${id}/seed/status`);
    expect(r.status).toBe(200);
    expect(r.body.seeded).toBe(false);
    expect(r.body.running).toBe(false);
  });

  it('POST /seed for a missing agent → 404', async () => {
    const r = await request(app).post(`/trading-agents/${randomUUID()}/seed`).send({});
    expect(r.status).toBe(404);
  });
});
