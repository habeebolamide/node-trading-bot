import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import {
  createDb, closeDb, paperPortfolio, paperPosition, paperPositionFill,
  prediction, predictionOutcome, scoringConfig, signal, tradingAgent, type Db,
} from '@tip/database';
import { createTradingAgent } from '@tip/trading-agents';
import {
  createPortfolio, openPendingPosition, activatePendingPosition, expirePendingPosition,
  openPositionCount, openPosition,
} from './index.js';

const DATABASE_URL = process.env.DATABASE_URL;
const T = new Date('2026-06-01T00:00:00Z');
const T_LATER = new Date(T.getTime() + 3600_000);

const cfg = {
  riskPercent: 0.01, minRR: 1.5, maxConcurrentPositions: 1, leverageMax: 10,
  agentWeights: { 'perp.momentum': 1 },
  confidenceWeights: { signalStrength: 0.3, agentAgreement: 0.3, historicalEvidence: 0.25, dataQuality: 0.15 },
  signalThresholds: { strongLong: 0.7, long: 0.45, weakLong: 0.2, weakShort: -0.2, short: -0.45, strongShort: -0.7 },
};

describe.skipIf(!DATABASE_URL)('LIMIT paper positions (m6-limit-orders-perp)', () => {
  let db: Db;
  let agentId: string;
  let portfolioId: string;
  const created = { agents: [] as string[], portfolios: [] as string[], positions: [] as string[], signals: [] as string[], predictions: [] as string[] };

  async function makePrediction(): Promise<string> {
    const sigId = randomUUID(); created.signals.push(sigId);
    await db.insert(signal).values({
      id: sigId, tradingAgentId: agentId, symbol: 'BTCUSDT', domain: 'perp', direction: 'LONG',
      compositeScore: '0.6', confidence: '0.7', state: 'CONSUMED',
      createdAt: T, expiresAt: new Date(T.getTime() + 60_000), configVersion: 1,
      fingerprint: `lim-${randomUUID().slice(0, 8)}`, evidence: {},
    });
    const predId = randomUUID(); created.predictions.push(predId);
    await db.insert(prediction).values({
      id: predId, tradingAgentId: agentId, signalId: sigId, domain: 'perp', symbol: 'BTCUSDT',
      direction: 'LONG', score: '0.6', confidence: '0.7', horizon: '4h',
      entry: '99', stopLoss: '95', takeProfit: '107',
      positionSize: '1', notional: '99', leverage: '5', requiredMargin: '20',
      riskReward: '2', features: [], configVersion: 1, createdAt: T,
    });
    return predId;
  }

  beforeAll(async () => {
    db = createDb(DATABASE_URL!);
    const a = await createTradingAgent(db, {
      name: `LIM-${randomUUID().slice(0, 6)}`, domain: 'perp', universe: ['BTCUSDT'], tradingStyle: 'day', config: cfg,
    });
    agentId = a.id; created.agents.push(agentId);
    const p = await createPortfolio(db, { tradingAgentId: agentId, startingCash: 10_000 });
    portfolioId = p.id; created.portfolios.push(portfolioId);
  });
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
      if (created.signals.length) await db.delete(signal).where(inArray(signal.id, created.signals));
      for (const id of created.agents) {
        await db.delete(scoringConfig).where(eq(scoringConfig.tradingAgentId, id));
        await db.delete(tradingAgent).where(eq(tradingAgent.id, id));
      }
      await closeDb(db);
    }
  });

  it('openPendingPosition creates a PENDING_ENTRY row with no fill', async () => {
    const predId = await makePrediction();
    const pos = await openPendingPosition(db, {
      portfolioId, predictionId: predId, symbol: 'BTCUSDT', domain: 'perp', direction: 'LONG',
      entryPrice: 99, size: 1, currentStop: 95, takeProfit: 107, ladder: null,
      openedAtEvent: T, openedAtProcessing: T,
    });
    created.positions.push(pos.id);
    expect(pos.state).toBe('PENDING_ENTRY');
    const fills = await db.select().from(paperPositionFill).where(eq(paperPositionFill.positionId, pos.id));
    expect(fills).toHaveLength(0); // no fill yet — nothing committed
  });

  it('openPositionCount includes PENDING_ENTRY so maxConcurrentPositions honours queued LIMITs', async () => {
    const before = await openPositionCount(db, portfolioId);
    const predId = await makePrediction();
    const pos = await openPendingPosition(db, {
      portfolioId, predictionId: predId, symbol: 'BTCUSDT', domain: 'perp', direction: 'LONG',
      entryPrice: 99, size: 1, currentStop: 95, takeProfit: 107, ladder: null,
      openedAtEvent: T, openedAtProcessing: T,
    });
    created.positions.push(pos.id);
    expect(await openPositionCount(db, portfolioId)).toBe(before + 1);
  });

  it('activatePendingPosition flips PENDING_ENTRY → OPEN, writes a LIMIT_FILL row, updates T1', async () => {
    const predId = await makePrediction();
    const pos = await openPendingPosition(db, {
      portfolioId, predictionId: predId, symbol: 'BTCUSDT', domain: 'perp', direction: 'LONG',
      entryPrice: 99, size: 1, currentStop: 95, takeProfit: 107, ladder: null,
      openedAtEvent: T, openedAtProcessing: T,
    });
    created.positions.push(pos.id);
    const activated = await activatePendingPosition(db, {
      positionId: pos.id, fillPrice: 99, clocks: { fillAtEvent: T_LATER, fillAtProcessing: T_LATER },
    });
    expect(activated.state).toBe('OPEN');
    expect(activated.openedAtProcessing).toEqual(T_LATER);
    const fills = await db.select().from(paperPositionFill).where(eq(paperPositionFill.positionId, pos.id));
    expect(fills.map((f) => f.reason)).toEqual(['LIMIT_FILL']);
  });

  it('activate is idempotent — a second call is a no-op', async () => {
    const predId = await makePrediction();
    const pos = await openPendingPosition(db, {
      portfolioId, predictionId: predId, symbol: 'BTCUSDT', domain: 'perp', direction: 'LONG',
      entryPrice: 99, size: 1, currentStop: 95, takeProfit: 107, ladder: null,
      openedAtEvent: T, openedAtProcessing: T,
    });
    created.positions.push(pos.id);
    await activatePendingPosition(db, { positionId: pos.id, fillPrice: 99, clocks: { fillAtEvent: T, fillAtProcessing: T } });
    const again = await activatePendingPosition(db, { positionId: pos.id, fillPrice: 90, clocks: { fillAtEvent: T, fillAtProcessing: T } });
    expect(again.state).toBe('OPEN');
    expect(again.entryPrice).toBe(99); // second activation ignored, entry stays put
    const fills = await db.select().from(paperPositionFill).where(eq(paperPositionFill.positionId, pos.id));
    expect(fills).toHaveLength(1);
  });

  it('expirePendingPosition marks EXPIRED with LIMIT_EXPIRY reason, no P&L, no fill row', async () => {
    const predId = await makePrediction();
    const pos = await openPendingPosition(db, {
      portfolioId, predictionId: predId, symbol: 'BTCUSDT', domain: 'perp', direction: 'LONG',
      entryPrice: 99, size: 1, currentStop: 95, takeProfit: 107, ladder: null,
      openedAtEvent: T, openedAtProcessing: T,
    });
    created.positions.push(pos.id);
    const expired = await expirePendingPosition(db, pos.id, T_LATER);
    expect(expired.state).toBe('EXPIRED');
    expect(expired.closeReason).toBe('LIMIT_EXPIRY');
    expect(expired.realizedPnl).toBe(0);
    const fills = await db.select().from(paperPositionFill).where(eq(paperPositionFill.positionId, pos.id));
    expect(fills).toHaveLength(0);
  });

  it('MARKET path (openPosition) is unchanged — regression check', async () => {
    const predId = await makePrediction();
    const pos = await openPosition(db, {
      portfolioId, predictionId: predId, symbol: 'BTCUSDT', domain: 'perp', direction: 'LONG',
      entryPrice: 100, size: 1, currentStop: 98, takeProfit: 104, ladder: null,
      openedAtEvent: T, openedAtProcessing: T,
    });
    created.positions.push(pos.id);
    expect(pos.state).toBe('OPEN');
    const fills = await db.select().from(paperPositionFill).where(eq(paperPositionFill.positionId, pos.id));
    expect(fills.map((f) => f.reason)).toEqual(['ENTRY']);
  });
});
