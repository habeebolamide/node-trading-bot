import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import {
  createDb, closeDb, paperPortfolio, paperPosition, paperPositionFill,
  prediction, predictionOutcome, signal, tradingAgent, scoringConfig, type Db,
} from '@tip/database';
import { createTradingAgent } from '@tip/trading-agents';
import { createPortfolio, getPortfolio } from './portfolio.js';
import { applyLadderRung, closeRemaining, openPosition, openPositionCount, updateExcursion } from './position.js';

const DATABASE_URL = process.env.DATABASE_URL;
const T = new Date('2026-06-01T00:00:00Z');

const perpConfig = {
  riskPercent: 0.01, minRR: 1.5, maxConcurrentPositions: 1, leverageMax: 10,
  agentWeights: { 'perp.momentum': 1 },
  confidenceWeights: { signalStrength: 0.3, agentAgreement: 0.3, historicalEvidence: 0.25, dataQuality: 0.15 },
  signalThresholds: { strongLong: 0.7, long: 0.45, weakLong: 0.2, weakShort: -0.2, short: -0.45, strongShort: -0.7 },
};

describe.skipIf(!DATABASE_URL)('paper engine positions (integration, Postgres)', () => {
  let db: Db;
  let agentId: string;
  let portfolioId: string;
  const created = { agents: [] as string[], portfolios: [] as string[], positions: [] as string[], signals: [] as string[], predictions: [] as string[] };

  async function makePrediction(): Promise<string> {
    const sigId = randomUUID();
    created.signals.push(sigId);
    await db.insert(signal).values({
      id: sigId, tradingAgentId: agentId, symbol: 'BTCUSDT', domain: 'perp', direction: 'LONG',
      compositeScore: '0.6', confidence: '0.7', state: 'CONSUMED',
      createdAt: T, expiresAt: new Date(T.getTime() + 60_000), configVersion: 1,
      fingerprint: `pe-${randomUUID().slice(0, 8)}`, evidence: {},
    });
    const predId = randomUUID();
    created.predictions.push(predId);
    await db.insert(prediction).values({
      id: predId, tradingAgentId: agentId, signalId: sigId, domain: 'perp', symbol: 'BTCUSDT',
      direction: 'LONG', score: '0.6', confidence: '0.7', horizon: '4h',
      entry: '100', stopLoss: '90', takeProfit: '120',
      positionSize: '1', notional: '100', leverage: '5', requiredMargin: '20',
      riskReward: '2', features: [], configVersion: 1,
    });
    return predId;
  }

  beforeAll(async () => {
    db = createDb(DATABASE_URL!);
    const a = await createTradingAgent(db, {
      name: `PE-${randomUUID().slice(0, 6)}`, domain: 'perp', universe: ['BTCUSDT'], tradingStyle: 'day', config: perpConfig,
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

  it('openPosition inserts a position and an ENTRY fill with BOTH clocks recorded (§20)', async () => {
    const predId = await makePrediction();
    const eventTime = new Date(T.getTime() + 1000);
    const processingTime = new Date(T.getTime() + 3400); // simulate 2.4s detection lag
    const pos = await openPosition(db, {
      portfolioId, predictionId: predId, symbol: 'BTCUSDT', domain: 'perp', direction: 'LONG',
      entryPrice: 100, size: 1, currentStop: 90, takeProfit: 120, ladder: null,
      openedAtEvent: eventTime, openedAtProcessing: processingTime,
    });
    created.positions.push(pos.id);
    expect(pos.state).toBe('OPEN');
    expect(pos.openedAtEvent).toEqual(eventTime);
    expect(pos.openedAtProcessing).toEqual(processingTime);

    const fills = await db.select().from(paperPositionFill).where(eq(paperPositionFill.positionId, pos.id));
    expect(fills).toHaveLength(1);
    expect(fills[0]!.reason).toBe('ENTRY');
    expect(fills[0]!.fillAtEvent).toEqual(eventTime);
    expect(fills[0]!.fillAtProcessing).toEqual(processingTime);
  });

  it('unique(prediction_id) prevents a double-open under concurrency', async () => {
    const predId = await makePrediction();
    const args = {
      portfolioId, predictionId: predId, symbol: 'BTCUSDT', domain: 'perp' as const, direction: 'LONG' as const,
      entryPrice: 100, size: 1, currentStop: 90, takeProfit: null, ladder: null,
      openedAtEvent: T, openedAtProcessing: T,
    };
    const results = await Promise.allSettled([openPosition(db, args), openPosition(db, args)]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const err = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(err).toHaveLength(1);
    if (ok[0]!.status === 'fulfilled') created.positions.push(ok[0]!.value.id);
  });

  it('LADDER RUNG: partial close, stop moved, remaining_size decreases, portfolio cash += pnl', async () => {
    const predId = await makePrediction();
    const pos = await openPosition(db, {
      portfolioId, predictionId: predId, symbol: 'MEME', domain: 'memecoin', direction: 'LONG',
      entryPrice: 1, size: 100, currentStop: 0.8, takeProfit: null,
      ladder: [{ at: 2, sellFraction: 0.5, postTakeAction: 'move_stop_to_breakeven' }, { at: 3, sellFraction: 0.25 }],
      openedAtEvent: T, openedAtProcessing: T,
    });
    created.positions.push(pos.id);
    const cashBefore = (await getPortfolio(db, portfolioId))!.cash;

    const after = await applyLadderRung(db, {
      positionId: pos.id, rungIndex: 0, rungPrice: 2, rung: { at: 2, sellFraction: 0.5, postTakeAction: 'move_stop_to_breakeven' },
      clocks: { fillAtEvent: T, fillAtProcessing: T },
    });
    expect(after.firedRungs).toEqual([0]);
    expect(after.remainingSize).toBeCloseTo(50, 10); // 100 − 50%×100
    expect(after.currentStop).toBeCloseTo(1, 10);    // moved to breakeven
    expect(after.realizedPnl).toBeCloseTo(50, 10);   // (2 − 1) × 50

    const cashAfter = (await getPortfolio(db, portfolioId))!.cash;
    expect(cashAfter - cashBefore).toBeCloseTo(50, 10);
  });

  it('LADDER re-fire of the same rung is a no-op (idempotent)', async () => {
    const predId = await makePrediction();
    const pos = await openPosition(db, {
      portfolioId, predictionId: predId, symbol: 'MEME', domain: 'memecoin', direction: 'LONG',
      entryPrice: 1, size: 100, currentStop: 0.8, takeProfit: null,
      ladder: [{ at: 2, sellFraction: 0.5 }],
      openedAtEvent: T, openedAtProcessing: T,
    });
    created.positions.push(pos.id);
    await applyLadderRung(db, { positionId: pos.id, rungIndex: 0, rungPrice: 2, rung: { at: 2, sellFraction: 0.5 }, clocks: { fillAtEvent: T, fillAtProcessing: T } });
    const after = await applyLadderRung(db, { positionId: pos.id, rungIndex: 0, rungPrice: 2, rung: { at: 2, sellFraction: 0.5 }, clocks: { fillAtEvent: T, fillAtProcessing: T } });
    expect(after.remainingSize).toBeCloseTo(50, 10); // still 50, not 0
    expect(after.realizedPnl).toBeCloseTo(50, 10);   // pnl booked once
  });

  it('closeRemaining after a partial ladder closes EXACTLY the remaining size, not the original', async () => {
    // The Part II §10 rule that "full close" is 100% of what is CURRENTLY held. A rule 25 bug
    // would size from `size` instead of `remaining_size` and try to sell 100 units when only
    // 50 remain — that's the class of "negative-size fill" the mandate exists to prevent.
    const predId = await makePrediction();
    const pos = await openPosition(db, {
      portfolioId, predictionId: predId, symbol: 'MEME', domain: 'memecoin', direction: 'LONG',
      entryPrice: 1, size: 100, currentStop: 0.8, takeProfit: null,
      ladder: [{ at: 2, sellFraction: 0.5 }],
      openedAtEvent: T, openedAtProcessing: T,
    });
    created.positions.push(pos.id);
    await applyLadderRung(db, { positionId: pos.id, rungIndex: 0, rungPrice: 2, rung: { at: 2, sellFraction: 0.5 }, clocks: { fillAtEvent: T, fillAtProcessing: T } });
    const closed = await closeRemaining(db, { positionId: pos.id, price: 3, reason: 'HORIZON_EXPIRY', clocks: { fillAtEvent: T, fillAtProcessing: T } });
    expect(closed.state).toBe('CLOSED');
    expect(closed.remainingSize).toBe(0);
    // Rung P&L: (2−1)×50 = 50. Close P&L: (3−1)×50 = 100. Total realized: 150.
    expect(closed.realizedPnl).toBeCloseTo(150, 10);

    const fills = await db.select().from(paperPositionFill).where(eq(paperPositionFill.positionId, pos.id));
    // ENTRY + LADDER_RUNG_0 + HORIZON_EXPIRY
    expect(fills.map((f) => f.reason).sort()).toEqual(['ENTRY', 'HORIZON_EXPIRY', 'LADDER_RUNG_0']);
    const finalFill = fills.find((f) => f.reason === 'HORIZON_EXPIRY')!;
    expect(finalFill.isFinal).toBe(true);
    expect(Number(finalFill.sizeFraction)).toBeCloseTo(0.5, 10);
  });

  it('closeRemaining is idempotent — a second close is a no-op', async () => {
    const predId = await makePrediction();
    const pos = await openPosition(db, {
      portfolioId, predictionId: predId, symbol: 'BTCUSDT', domain: 'perp', direction: 'LONG',
      entryPrice: 100, size: 1, currentStop: 90, takeProfit: 120, ladder: null,
      openedAtEvent: T, openedAtProcessing: T,
    });
    created.positions.push(pos.id);
    const first = await closeRemaining(db, { positionId: pos.id, price: 120, reason: 'TAKE_PROFIT', clocks: { fillAtEvent: T, fillAtProcessing: T } });
    const again = await closeRemaining(db, { positionId: pos.id, price: 50, reason: 'STOP_LOSS', clocks: { fillAtEvent: T, fillAtProcessing: T } });
    expect(first.realizedPnl).toBeCloseTo(20, 10);
    expect(again.realizedPnl).toBeCloseTo(first.realizedPnl, 10); // unchanged; the second call did nothing
  });

  it('portfolio drawdown records the deepest fractional trough below peak', async () => {
    // Fresh portfolio so peer tests do not contaminate the arithmetic.
    const p = await createPortfolio(db, { tradingAgentId: agentId, startingCash: 1000 });
    created.portfolios.push(p.id);
    const predId = await makePrediction();
    const pos = await openPosition(db, {
      portfolioId: p.id, predictionId: predId, symbol: 'BTCUSDT', domain: 'perp', direction: 'LONG',
      entryPrice: 100, size: 1, currentStop: 90, takeProfit: null, ladder: null,
      openedAtEvent: T, openedAtProcessing: T,
    });
    created.positions.push(pos.id);
    // A losing close of −$50 → cash 950, peak 1000, drawdown 5%.
    await closeRemaining(db, { positionId: pos.id, price: 50, reason: 'STOP_LOSS', clocks: { fillAtEvent: T, fillAtProcessing: T } });
    const after = (await getPortfolio(db, p.id))!;
    expect(after.realizedPnl).toBeCloseTo(-50, 10);
    expect(after.cash).toBeCloseTo(950, 10);
    expect(after.peakEquity).toBeCloseTo(1000, 10);
    expect(after.maxDrawdown).toBeCloseTo(0.05, 10);
  });

  it('MFE/MAE track direction-signed excursion', async () => {
    const predId = await makePrediction();
    const pos = await openPosition(db, {
      portfolioId, predictionId: predId, symbol: 'BTCUSDT', domain: 'perp', direction: 'SHORT',
      entryPrice: 100, size: 1, currentStop: 110, takeProfit: 90, ladder: null,
      openedAtEvent: T, openedAtProcessing: T,
    });
    created.positions.push(pos.id);
    await updateExcursion(db, pos.id, 95); // favourable for SHORT
    await updateExcursion(db, pos.id, 105); // adverse
    const r = (await db.select().from(paperPosition).where(eq(paperPosition.id, pos.id)).limit(1))[0]!;
    expect(Number(r.mfe)).toBeCloseTo(5, 10);
    expect(Number(r.mae)).toBeCloseTo(-5, 10);
  });

  it('openPositionCount returns the current OPEN count for the portfolio', async () => {
    const before = await openPositionCount(db, portfolioId);
    const predId = await makePrediction();
    const pos = await openPosition(db, {
      portfolioId, predictionId: predId, symbol: 'BTCUSDT', domain: 'perp', direction: 'LONG',
      entryPrice: 100, size: 1, currentStop: 90, takeProfit: 120, ladder: null,
      openedAtEvent: T, openedAtProcessing: T,
    });
    created.positions.push(pos.id);
    const after = await openPositionCount(db, portfolioId);
    expect(after).toBe(before + 1);
    await closeRemaining(db, { positionId: pos.id, price: 120, reason: 'TAKE_PROFIT', clocks: { fillAtEvent: T, fillAtProcessing: T } });
    expect(await openPositionCount(db, portfolioId)).toBe(before);
  });
});
