import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  createDb, closeDb, judgeDecision, prediction, predictionOutcome, scoringConfig,
  signal, signalFeature, tradingAgent, type Db,
} from '@tip/database';
import { createTradingAgent } from '@tip/trading-agents';
import { compareShadowVsBaseline, compareShadowVsReal } from './shadow.js';

const DATABASE_URL = process.env.DATABASE_URL;
const CFG_BASE = {
  riskPercent: 0.01, minRR: 1.5, maxConcurrentPositions: 1, leverageMax: 10,
  agentWeights: { 'perp.momentum': 1 },
  confidenceWeights: { signalStrength: 0.3, agentAgreement: 0.3, historicalEvidence: 0.25, dataQuality: 0.15 },
  signalThresholds: { strongLong: 0.7, long: 0.45, weakLong: 0.2, weakShort: -0.2, short: -0.45, strongShort: -0.7 },
};

const V_SHADOW = 610; // unique high-numbered version (parallel-file isolation, like m6-metrics)

describe.skipIf(!DATABASE_URL)('shadow reporting (integration)', () => {
  let db: Db;
  let agentId: string;
  const created = { agents: [] as string[], signals: [] as string[], predictions: [] as string[] };

  async function seedPair(input: {
    judgeAction: 'FLIP' | 'STAND_ASIDE' | 'AGREE' | 'DEFER';
    realDirection: 'LONG' | 'SHORT';
    realWon: boolean; realReturn: number;
    /** Only meaningful for FLIP + STAND_ASIDE. */
    shadowWon?: boolean; shadowReturn?: number;
    shadowDirection?: 'LONG' | 'SHORT';
  }): Promise<{ sid: string }> {
    const sid = randomUUID(); created.signals.push(sid);
    await db.insert(signal).values({
      id: sid, tradingAgentId: agentId, symbol: 'BTCUSDT', domain: 'perp',
      direction: input.realDirection, compositeScore: '0.6', confidence: '0.45',
      state: 'CONSUMED', createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
      configVersion: V_SHADOW, fingerprint: `srp-${randomUUID().slice(0, 8)}`, evidence: {},
    });
    // Judge decision (only if not implicit AGREE — but seed it anyway for the FLIP/STAND cases).
    if (input.judgeAction !== 'AGREE') {
      await db.insert(judgeDecision).values({
        signalId: sid, judgeVersion: 1, judgeAction: input.judgeAction,
        detConfidence: '0.45', judgeConfidence: '0.85',
        detDirection: input.realDirection, judgeDirection: input.shadowDirection ?? 'SHORT',
        gap: '0.4', configVersion: V_SHADOW,
      });
    }
    // Real prediction (FLIP/AGREE/DEFER get one; STAND_ASIDE does not).
    if (input.judgeAction !== 'STAND_ASIDE') {
      const realId = randomUUID(); created.predictions.push(realId);
      await db.insert(prediction).values({
        id: realId, tradingAgentId: agentId, signalId: sid, domain: 'perp', symbol: 'BTCUSDT',
        direction: input.realDirection, score: '0.6', confidence: '0.85', horizon: '4h',
        entry: '100', stopLoss: '98', takeProfit: '104', positionSize: '1', notional: '100', leverage: '5', requiredMargin: '20',
        riskReward: '2', features: [], configVersion: V_SHADOW,
        isShadow: false, shadowOf: null,
      });
      await db.insert(predictionOutcome).values({
        predictionId: realId, horizon: '4h',
        resolvedAt: new Date(), returnPct: String(input.realReturn), mfe: '0', mae: '0',
        hitTarget: input.realWon, hitInvalidation: !input.realWon, holdingPeriodSec: 3600,
        won: input.realWon, outcomeResolution: 'TICK',
      });
    }
    // Shadow prediction (FLIP + STAND_ASIDE get one).
    if (input.judgeAction === 'FLIP' || input.judgeAction === 'STAND_ASIDE') {
      const shadowId = randomUUID(); created.predictions.push(shadowId);
      const realId = input.judgeAction === 'FLIP'
        ? (await db.select({ id: prediction.id }).from(prediction).where(and(eq(prediction.signalId, sid), eq(prediction.isShadow, false))))[0]?.id ?? null
        : null;
      await db.insert(prediction).values({
        id: shadowId, tradingAgentId: agentId, signalId: sid, domain: 'perp', symbol: 'BTCUSDT',
        direction: input.shadowDirection ?? 'LONG', score: '0.6', confidence: '0.45', horizon: '4h',
        entry: '100', stopLoss: '98', takeProfit: '104', positionSize: '1', notional: '100', leverage: '5', requiredMargin: '20',
        riskReward: '2', features: [], configVersion: V_SHADOW,
        isShadow: true, shadowOf: realId,
      });
      await db.insert(predictionOutcome).values({
        predictionId: shadowId, horizon: '4h',
        resolvedAt: new Date(), returnPct: String(input.shadowReturn ?? 0), mfe: '0', mae: '0',
        hitTarget: input.shadowWon ?? false, hitInvalidation: !(input.shadowWon ?? false), holdingPeriodSec: 3600,
        won: input.shadowWon ?? false, outcomeResolution: 'TICK',
      });
    }
    return { sid };
  }

  beforeAll(async () => {
    db = createDb(DATABASE_URL!);
    const a = await createTradingAgent(db, {
      name: `SR-${randomUUID().slice(0, 6)}`, domain: 'perp', universe: ['BTCUSDT'], tradingStyle: 'day', config: CFG_BASE,
    });
    agentId = a.id; created.agents.push(agentId);
  });

  afterAll(async () => {
    if (db) {
      if (created.signals.length) await db.delete(judgeDecision).where(inArray(judgeDecision.signalId, created.signals));
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

  it('compareShadowVsReal: null groups on an empty history (bootstrap-safe)', async () => {
    const r = await compareShadowVsReal(db, { configVersion: 99_999, horizon: '4h', asOf: new Date() });
    expect(r.flipRealGroup.n).toBe(0);
    expect(r.flipShadowGroup.n).toBe(0);
  });

  it('compareShadowVsReal: reads both real and shadow outcomes for FLIP signals', async () => {
    // 3 FLIP pairs: real wins 2/3, shadow wins 1/3.
    await seedPair({ judgeAction: 'FLIP', realDirection: 'SHORT', realWon: true, realReturn: 0.03, shadowWon: false, shadowReturn: -0.02, shadowDirection: 'LONG' });
    await seedPair({ judgeAction: 'FLIP', realDirection: 'SHORT', realWon: true, realReturn: 0.04, shadowWon: false, shadowReturn: -0.03, shadowDirection: 'LONG' });
    await seedPair({ judgeAction: 'FLIP', realDirection: 'SHORT', realWon: false, realReturn: -0.02, shadowWon: true, shadowReturn: 0.03, shadowDirection: 'LONG' });
    const r = await compareShadowVsReal(db, { configVersion: V_SHADOW, horizon: '4h', asOf: new Date(Date.now() + 60_000) });
    expect(r.flipRealGroup.n).toBe(3);
    expect(r.flipShadowGroup.n).toBe(3);
    expect(r.flipRealGroup.wins).toBe(2);
    expect(r.flipShadowGroup.wins).toBe(1);
    expect(r.flipRealGroup.winRate!).toBeGreaterThan(r.flipShadowGroup.winRate!);
  });

  it('compareShadowVsBaseline: STAND_ASIDE shadow vs AGREE/DEFER baseline', async () => {
    // STAND_ASIDE: 2 shadow rows, both lose (i.e. STAND_ASIDE saved the trade).
    await seedPair({ judgeAction: 'STAND_ASIDE', realDirection: 'LONG', realWon: false, realReturn: 0, shadowWon: false, shadowReturn: -0.05, shadowDirection: 'LONG' });
    await seedPair({ judgeAction: 'STAND_ASIDE', realDirection: 'LONG', realWon: false, realReturn: 0, shadowWon: false, shadowReturn: -0.04, shadowDirection: 'LONG' });
    // Baseline (DEFER): 3 real predictions, 2 winning.
    await seedPair({ judgeAction: 'DEFER', realDirection: 'LONG', realWon: true, realReturn: 0.03 });
    await seedPair({ judgeAction: 'DEFER', realDirection: 'LONG', realWon: true, realReturn: 0.04 });
    await seedPair({ judgeAction: 'DEFER', realDirection: 'LONG', realWon: false, realReturn: -0.02 });

    const r = await compareShadowVsBaseline(db, { domain: 'perp', configVersion: V_SHADOW, horizon: '4h', asOf: new Date(Date.now() + 60_000) });
    expect(r.standAsideShadowGroup.n).toBe(2);
    // Baseline includes both DEFER real predictions and any AGREE that came with real predictions.
    expect(r.baseline.n).toBeGreaterThanOrEqual(3);
    expect(r.standAsideShadowGroup.winRate).toBe(0);
    expect(r.baseline.winRate!).toBeGreaterThan(0);
  });
});
