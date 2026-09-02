import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import {
  createDb, closeDb, paperPortfolio, paperPosition, paperPositionFill,
  prediction, predictionOutcome, scoringConfig, signal, signalFeature, tradingAgent,
  type Db,
} from '@tip/database';
import { createTradingAgent } from '@tip/trading-agents';
import { createPortfolio, openPosition, openPositionCount } from '@tip/paper-engine';
import { insertFlipShadow, insertStandAsideShadow } from './shadow.js';

const DATABASE_URL = process.env.DATABASE_URL;
const CFG_BASE = {
  riskPercent: 0.01, minRR: 1.5, maxConcurrentPositions: 1, leverageMax: 10,
  agentWeights: { 'perp.momentum': 1 },
  confidenceWeights: { signalStrength: 0.3, agentAgreement: 0.3, historicalEvidence: 0.25, dataQuality: 0.15 },
  signalThresholds: { strongLong: 0.7, long: 0.45, weakLong: 0.2, weakShort: -0.2, short: -0.45, strongShort: -0.7 },
};

describe.skipIf(!DATABASE_URL)('shadow predictions (integration)', () => {
  let db: Db;
  const created = { agents: [] as string[], signals: [] as string[], predictions: [] as string[], portfolios: [] as string[], positions: [] as string[] };

  async function seedAgentSignal(): Promise<{ agentId: string; portfolioId: string; sid: string }> {
    const agent = await createTradingAgent(db, {
      name: `SH-${randomUUID().slice(0, 6)}`, domain: 'perp', universe: ['BTCUSDT'], tradingStyle: 'day', config: CFG_BASE,
    });
    created.agents.push(agent.id);
    const p = await createPortfolio(db, { tradingAgentId: agent.id, startingCash: 10_000 });
    created.portfolios.push(p.id);
    const sid = randomUUID(); created.signals.push(sid);
    await db.insert(signal).values({
      id: sid, tradingAgentId: agent.id, symbol: 'BTCUSDT', domain: 'perp',
      direction: 'LONG', compositeScore: '0.6', confidence: '0.45',
      state: 'CONSUMED', createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
      configVersion: 1, fingerprint: `sh-${randomUUID().slice(0, 8)}`, evidence: {},
    });
    return { agentId: agent.id, portfolioId: p.id, sid };
  }

  async function insertRealPrediction(sid: string, agentId: string): Promise<string> {
    const predId = randomUUID(); created.predictions.push(predId);
    await db.insert(prediction).values({
      id: predId, tradingAgentId: agentId, signalId: sid, domain: 'perp', symbol: 'BTCUSDT',
      direction: 'SHORT', // Judge's direction — the FLIP put us on the short side
      score: '0.6', confidence: '0.85', horizon: '4h',
      entry: '100', stopLoss: '102', takeProfit: '95',
      positionSize: '1', notional: '100', leverage: '5', requiredMargin: '20',
      riskReward: '2.5', features: [], configVersion: 1,
      isShadow: false, shadowOf: null,
    });
    return predId;
  }

  beforeAll(() => { db = createDb(DATABASE_URL!); });
  afterAll(async () => {
    if (db) {
      if (created.positions.length) {
        await db.delete(paperPositionFill).where(inArray(paperPositionFill.positionId, created.positions));
        await db.delete(paperPosition).where(inArray(paperPosition.id, created.positions));
      }
      if (created.portfolios.length) await db.delete(paperPortfolio).where(inArray(paperPortfolio.id, created.portfolios));
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

  it('FLIP: insertFlipShadow writes a shadow with shadow_of = real prediction id, sharing signal_id', async () => {
    const { agentId, sid } = await seedAgentSignal();
    const realId = await insertRealPrediction(sid, agentId);
    const shadow = await insertFlipShadow(db, {
      signalId: sid, realPredictionId: realId,
      deterministicDirection: 'LONG',
      plan: { kind: 'TRADE', entry: 100, stopLoss: 98, takeProfit: 104, positionSize: 1, notional: 100, leverage: 5, requiredMargin: 20, riskReward: 2, horizon: '4h' },
      configVersion: 1, signalScore: 0.6, confidence: 0.45,
    });
    expect(shadow).not.toBeNull();
    created.predictions.push(shadow!.id);
    expect(shadow!.isShadow).toBe(true);
    expect(shadow!.shadowOf).toBe(realId);
    expect(shadow!.signalId).toBe(sid);
    expect(shadow!.direction).toBe('LONG');

    // Both real and shadow are readable off the same signal.
    const rows = await db.select({ id: prediction.id, isShadow: prediction.isShadow })
      .from(prediction).where(eq(prediction.signalId, sid));
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => !r.isShadow)).toHaveLength(1);
    expect(rows.filter((r) => r.isShadow)).toHaveLength(1);
  });

  it('FLIP: NO_TRADE plan → no shadow written (parity with the real path)', async () => {
    const { agentId, sid } = await seedAgentSignal();
    const realId = await insertRealPrediction(sid, agentId);
    const shadow = await insertFlipShadow(db, {
      signalId: sid, realPredictionId: realId,
      deterministicDirection: 'LONG',
      plan: { kind: 'NO_TRADE', reason: 'INSUFFICIENT_RR' },
      configVersion: 1, signalScore: 0.6, confidence: 0.45,
    });
    expect(shadow).toBeNull();
  });

  it('STAND_ASIDE: insertStandAsideShadow writes shadow with shadow_of = null', async () => {
    const { sid } = await seedAgentSignal();
    const shadow = await insertStandAsideShadow(db, {
      signalId: sid, deterministicDirection: 'LONG',
      plan: { kind: 'TRADE', entry: 100, stopLoss: 98, takeProfit: 104, positionSize: 1, notional: 100, leverage: 5, requiredMargin: 20, riskReward: 2, horizon: '4h' },
      configVersion: 1, signalScore: 0.6, confidence: 0.9,
    });
    expect(shadow).not.toBeNull();
    created.predictions.push(shadow!.id);
    expect(shadow!.isShadow).toBe(true);
    expect(shadow!.shadowOf).toBeNull();
  });

  it('openPositionCount EXCLUDES shadows so maxConcurrentPositions caps live-money-equivalent exposure', async () => {
    const { agentId, portfolioId, sid } = await seedAgentSignal();
    const realId = await insertRealPrediction(sid, agentId);
    const shadow = await insertFlipShadow(db, {
      signalId: sid, realPredictionId: realId,
      deterministicDirection: 'LONG',
      plan: { kind: 'TRADE', entry: 100, stopLoss: 98, takeProfit: 104, positionSize: 1, notional: 100, leverage: 5, requiredMargin: 20, riskReward: 2, horizon: '4h' },
      configVersion: 1, signalScore: 0.6, confidence: 0.45,
    });
    if (!shadow) throw new Error('shadow was null');
    created.predictions.push(shadow.id);

    const realPos = await openPosition(db, {
      portfolioId, predictionId: realId, symbol: 'BTCUSDT', domain: 'perp', direction: 'SHORT',
      entryPrice: 100, size: 1, currentStop: 102, takeProfit: 95, ladder: null,
      openedAtEvent: new Date(), openedAtProcessing: new Date(),
      isShadow: false,
    });
    created.positions.push(realPos.id);
    const shadowPos = await openPosition(db, {
      portfolioId, predictionId: shadow.id, symbol: 'BTCUSDT', domain: 'perp', direction: 'LONG',
      entryPrice: 100, size: 1, currentStop: 98, takeProfit: 104, ladder: null,
      openedAtEvent: new Date(), openedAtProcessing: new Date(),
      isShadow: true,
    });
    created.positions.push(shadowPos.id);

    expect(shadowPos.isShadow).toBe(true);
    // Only the REAL position is counted — a 1-max portfolio can still open real+shadow.
    expect(await openPositionCount(db, portfolioId)).toBe(1);
  });
});
