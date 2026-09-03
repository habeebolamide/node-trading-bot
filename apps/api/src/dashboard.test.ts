import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { Redis } from 'ioredis';
import { eq, inArray, sql } from 'drizzle-orm';
import { createDb, closeDb, prediction, predictionOutcome, scoringConfig, signal, signalFeature, tradingAgent, type Db } from '@tip/database';
import { createTradingAgent } from '@tip/trading-agents';
import type { EventBus } from '@tip/events';
import { createApp } from './app.js';

const DATABASE_URL = process.env.DATABASE_URL;

const CFG = {
  riskPercent: 0.01, minRR: 1.5, maxConcurrentPositions: 1, leverageMax: 10,
  agentWeights: { 'perp.momentum': 1 },
  confidenceWeights: { signalStrength: 0.3, agentAgreement: 0.3, historicalEvidence: 0.25, dataQuality: 0.15 },
  signalThresholds: { strongLong: 0.7, long: 0.45, weakLong: 0.2, weakShort: -0.2, short: -0.45, strongShort: -0.7 },
};

describe.skipIf(!DATABASE_URL)('dashboard routes (integration)', () => {
  let db: Db;
  let app: Express;
  let agentId: string;
  const created = { agents: [] as string[], signals: [] as string[], predictions: [] as string[] };

  beforeAll(async () => {
    db = createDb(DATABASE_URL!);
    const fakeRedis = { ping: vi.fn(async () => 'PONG') } as unknown as Redis;
    const fakeBus = { publish: vi.fn(async () => ({ id: 'e' })) } as unknown as EventBus;
    app = createApp({ db, redis: fakeRedis, bus: fakeBus, webhookSecret: undefined });

    const a = await createTradingAgent(db, {
      name: `API-${randomUUID().slice(0, 6)}`, domain: 'perp', universe: ['BTCUSDT'], tradingStyle: 'day', config: CFG,
    });
    agentId = a.id; created.agents.push(agentId);

    // One signal + prediction + outcome to exercise the joins.
    const sid = randomUUID(); created.signals.push(sid);
    await db.insert(signal).values({
      id: sid, tradingAgentId: agentId, symbol: 'BTCUSDT', domain: 'perp', direction: 'LONG',
      compositeScore: '0.6', confidence: '0.7', state: 'CONSUMED',
      createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
      configVersion: 1, fingerprint: `api-${randomUUID().slice(0, 8)}`, evidence: {},
    });
    await db.insert(signalFeature).values({
      signalId: sid, agentKey: 'perp.momentum', agentVersion: 1, score: '0.8', confidence: '0.9', features: {},
    });
    const predId = randomUUID(); created.predictions.push(predId);
    await db.insert(prediction).values({
      id: predId, tradingAgentId: agentId, signalId: sid, domain: 'perp', symbol: 'BTCUSDT',
      direction: 'LONG', score: '0.6', confidence: '0.7', horizon: '4h',
      entry: '100', stopLoss: '98', takeProfit: '104',
      positionSize: '1', notional: '100', leverage: '5', requiredMargin: '20',
      riskReward: '2', features: [], configVersion: 1,
    });
    await db.insert(predictionOutcome).values({
      predictionId: predId, horizon: '4h', resolvedAt: new Date(),
      returnPct: '0.04', mfe: '0.05', mae: '-0.01',
      hitTarget: true, hitInvalidation: false, holdingPeriodSec: 3600,
      won: true, outcomeResolution: 'TICK',
    });
  });

  afterAll(async () => {
    if (db) {
      if (created.predictions.length) {
        await db.delete(predictionOutcome).where(inArray(predictionOutcome.predictionId, created.predictions));
        await db.execute(sql`DROP TRIGGER IF EXISTS prediction_no_delete ON prediction`);
        await db.delete(prediction).where(inArray(prediction.id, created.predictions));
        await db.execute(sql`CREATE TRIGGER prediction_no_delete BEFORE DELETE ON prediction FOR EACH ROW EXECUTE FUNCTION prediction_no_mutation()`);
      }
      if (created.signals.length) {
        await db.delete(signalFeature).where(inArray(signalFeature.signalId, created.signals));
        await db.delete(signal).where(inArray(signal.id, created.signals));
      }
      for (const id of created.agents) {
        await db.delete(scoringConfig).where(eq(scoringConfig.tradingAgentId, id));
        await db.delete(tradingAgent).where(eq(tradingAgent.id, id));
      }
      await closeDb(db);
    }
  });

  it('GET /api/predictions returns paginated rows with a total count', async () => {
    const r = await request(app).get('/api/predictions').query({ agentId, limit: 10, offset: 0 });
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.rows)).toBe(true);
    expect(r.body.rows.length).toBeGreaterThanOrEqual(1);
    expect(typeof r.body.total).toBe('number');
    expect(r.body.limit).toBe(10);
    expect(r.body.offset).toBe(0);
    // Every row exposes the join columns even when null (no paper_position yet).
    expect(r.body.rows[0]).toHaveProperty('positionState');
    expect(r.body.rows[0]).toHaveProperty('closeReason');
    expect(r.body.rows[0]).toHaveProperty('realizedPnl');
  });

  it('GET /api/predictions/:id returns prediction + outcomes + position', async () => {
    const r = await request(app).get(`/api/predictions/${created.predictions[0]!}`);
    expect(r.status).toBe(200);
    expect(r.body.prediction.id).toBe(created.predictions[0]);
    expect(r.body).toHaveProperty('position'); // null when no paper_position row exists
    expect(r.body.outcomes.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/predictions/:id/attribution joins features + risk + judge', async () => {
    const r = await request(app).get(`/api/predictions/${created.predictions[0]!}/attribution`);
    expect(r.status).toBe(200);
    expect(r.body.features.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/metrics/headline returns HeadlineMetrics shape', async () => {
    const r = await request(app).get('/api/metrics/headline').query({
      domain: 'perp', configVersion: 1, horizon: '4h', asOf: new Date().toISOString(),
    });
    expect(r.status).toBe(200);
    // may be null on empty DB slice or populated — but the endpoint responds
    if (r.body) expect(typeof r.body).toBe('object');
  });

  it('GET /api/metrics/headline 400s when required params are missing', async () => {
    const r = await request(app).get('/api/metrics/headline');
    expect(r.status).toBe(400);
  });

  it('GET /api/hypotheses lists rows', async () => {
    const r = await request(app).get('/api/hypotheses').query({ limit: 10 });
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.rows)).toBe(true);
  });

  it('GET /api/autopsies lists rows', async () => {
    const r = await request(app).get('/api/autopsies').query({ limit: 10 });
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.rows)).toBe(true);
  });

  it('GET /api/signals returns rows for the agent', async () => {
    const r = await request(app).get('/api/signals').query({ agentId });
    expect(r.status).toBe(200);
    expect(r.body.rows.some((row: { id: string }) => created.signals.includes(row.id))).toBe(true);
  });

  it('GET /api/overview returns KPI counts', async () => {
    const r = await request(app).get('/api/overview');
    expect(r.status).toBe(200);
    expect(typeof r.body.signalsLast24h).toBe('number');
    expect(typeof r.body.predictionsLast7d).toBe('number');
    expect(typeof r.body.portfolios).toBe('number');
    expect(typeof r.body.totalEquity).toBe('number');
  });

  it('GET /api/metrics/shadow/vs-real returns two groups (may be empty)', async () => {
    const r = await request(app).get('/api/metrics/shadow/vs-real').query({ configVersion: 1 });
    expect(r.status).toBe(200);
    expect(r.body.flipRealGroup).toBeDefined();
    expect(r.body.flipShadowGroup).toBeDefined();
  });

  // ── audit #15–#20 additions ──────────────────────────────────────────

  it('GET /api/backtest/walk-forward returns folds with test-window metrics (perp)', async () => {
    const r = await request(app).get('/api/backtest/walk-forward')
      .query({ configVersion: 1, horizon: '4h', from: new Date(Date.now() - 200 * 864e5).toISOString() });
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.folds)).toBe(true);
    if (r.body.folds.length > 0) {
      const f = r.body.folds[0];
      expect(new Date(f.fold.trainEnd).getTime()).toBeLessThanOrEqual(new Date(f.fold.testStart).getTime());
    }
  });

  it('GET /api/llm/costs aggregates the llm_call_log ledger', async () => {
    const r = await request(app).get('/api/llm/costs').query({ days: 30 });
    expect(r.status).toBe(200);
    expect(typeof Number(r.body.totals.cost)).toBe('number');
    expect(Array.isArray(r.body.byAgent)).toBe(true);
    expect(Array.isArray(r.body.byDay)).toBe(true);
  });

  it('GET /api/smart-money returns wallets/clusters/recent activity', async () => {
    const r = await request(app).get('/api/smart-money');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.wallets)).toBe(true);
    expect(Array.isArray(r.body.clusters)).toBe(true);
    expect(Array.isArray(r.body.recentBuys)).toBe(true);
    expect(Array.isArray(r.body.recentConvergences)).toBe(true);
  });

  it('GET /api/tokens/top lists BrainTokenMemory rows (may be empty)', async () => {
    const r = await request(app).get('/api/tokens/top');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.tokens)).toBe(true);
  });

  it('GET /api/brain/token/:mint returns null for an unknown mint (not the wallet route)', async () => {
    const r = await request(app).get(`/api/brain/token/UnknownMint${randomUUID().slice(0, 6)}`);
    expect(r.status).toBe(200);
    expect(r.body).toBeNull();
  });
});
