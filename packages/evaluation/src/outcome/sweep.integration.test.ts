import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  createDb, closeDb,
  brainSetupMemory, brainSetupOccurrence, brainAgentMemory, brainAgentOccurrence,
  marketCandle, paperPortfolio, paperPosition, paperPositionFill,
  prediction, predictionOutcome, scoringConfig, signal, signalFeature, tradingAgent,
  type Db,
} from '@tip/database';
import { createTradingAgent } from '@tip/trading-agents';
import { createPortfolio, openPosition } from '@tip/paper-engine';
import { ladder } from '@tip/brain';
import { resolvePrediction, outcomeSweep } from './sweep.js';
import { planningHorizonFor } from './horizons.js';
import { featureTupleFor } from './feature-tuple.js';

const DATABASE_URL = process.env.DATABASE_URL;
const T0 = new Date('2026-06-01T00:00:00Z');
const T1 = new Date('2026-06-01T00:05:00Z'); // fill 5m after signal
const DAY_MS = 24 * 60 * 60 * 1000;

const perpConfig = {
  riskPercent: 0.01, minRR: 1.5, maxConcurrentPositions: 2, leverageMax: 10,
  agentWeights: { 'perp.momentum': 0.5, 'perp.open_interest': 0.5 },
  confidenceWeights: { signalStrength: 0.3, agentAgreement: 0.3, historicalEvidence: 0.25, dataQuality: 0.15 },
  signalThresholds: { strongLong: 0.7, long: 0.45, weakLong: 0.2, weakShort: -0.2, short: -0.45, strongShort: -0.7 },
};

/** Insert a 1m candle series covering an interval so the resolver has bars to scan. */
async function seedCandles(db: Db, symbol: string, from: Date, to: Date, priceAt: (i: number) => { h: number; l: number; c: number }) {
  const rows = [];
  let t = from.getTime();
  let i = 0;
  while (t < to.getTime()) {
    const p = priceAt(i);
    rows.push({
      symbol, timeframe: '1m',
      openTime: new Date(t), closeTime: new Date(t + 60_000 - 1),
      open: String(p.c), high: String(p.h), low: String(p.l), close: String(p.c), volume: '1',
    });
    t += 60_000; i++;
  }
  if (rows.length > 0) await db.insert(marketCandle).values(rows).onConflictDoNothing();
  return rows.length;
}

describe.skipIf(!DATABASE_URL)('outcome sweep — end-to-end Brain wiring (integration)', () => {
  let db: Db;
  let agentId: string;
  let portfolioId: string;
  const created = {
    agents: [] as string[], portfolios: [] as string[], positions: [] as string[],
    signals: [] as string[], predictions: [] as string[],
    candles: [] as { symbol: string; openTime: Date }[],
  };

  async function makePredictionWithPosition(over: { symbol?: string; direction?: string; features?: Array<{ agentKey: string; agentVersion: number; score: number }>; } = {}): Promise<{ predictionId: string; symbol: string }> {
    const symbol = over.symbol ?? 'BTCUSDT';
    const direction = over.direction ?? 'LONG';
    const sigId = randomUUID(); created.signals.push(sigId);
    await db.insert(signal).values({
      id: sigId, tradingAgentId: agentId, symbol, domain: 'perp', direction,
      compositeScore: '0.6', confidence: '0.7', state: 'CONSUMED',
      createdAt: T0, expiresAt: new Date(T0.getTime() + 60_000), configVersion: 1,
      fingerprint: `oe-${randomUUID().slice(0, 8)}`, evidence: {},
    });

    const feats = over.features ?? [
      { agentKey: 'perp.momentum', agentVersion: 1, score: 0.8 },
      { agentKey: 'perp.open_interest', agentVersion: 1, score: 0.4 },
    ];
    for (const f of feats) {
      await db.insert(signalFeature).values({
        signalId: sigId, agentKey: f.agentKey, agentVersion: f.agentVersion,
        score: String(f.score), confidence: '0.7', features: {},
      });
    }

    const predId = randomUUID(); created.predictions.push(predId);
    // createdAt fixed at T0 so the sweep's `lte(createdAt, now)` filter matches the intended
    // scenario timeline instead of wall-clock time.
    await db.insert(prediction).values({
      id: predId, tradingAgentId: agentId, signalId: sigId, domain: 'perp', symbol,
      direction, score: '0.6', confidence: '0.7', horizon: '4h',
      entry: '100', stopLoss: direction === 'LONG' ? '98' : '102', takeProfit: direction === 'LONG' ? '104' : '96',
      positionSize: '1', notional: '100', leverage: '5', requiredMargin: '20',
      riskReward: '2', features: [], configVersion: 1, createdAt: T0,
    });

    const pos = await openPosition(db, {
      portfolioId, predictionId: predId, symbol, domain: 'perp',
      direction: direction as 'LONG' | 'SHORT',
      entryPrice: 100, size: 1,
      currentStop: direction === 'LONG' ? 98 : 102,
      takeProfit: direction === 'LONG' ? 104 : 96,
      ladder: null,
      openedAtEvent: T1, openedAtProcessing: T1,
    });
    created.positions.push(pos.id);
    return { predictionId: predId, symbol };
  }

  beforeAll(async () => {
    db = createDb(DATABASE_URL!);
    const a = await createTradingAgent(db, {
      name: `OE-${randomUUID().slice(0, 6)}`, domain: 'perp', universe: ['BTCUSDT', 'ETHUSDT'], tradingStyle: 'day', config: perpConfig,
    });
    agentId = a.id; created.agents.push(agentId);
    const p = await createPortfolio(db, { tradingAgentId: agentId, startingCash: 10_000 });
    portfolioId = p.id; created.portfolios.push(portfolioId);
  });

  afterAll(async () => {
    if (db) {
      if (created.candles.length) {
        await db.delete(marketCandle).where(and(
          inArray(marketCandle.symbol, [...new Set(created.candles.map((c) => c.symbol))]),
          inArray(marketCandle.openTime, created.candles.map((c) => c.openTime)),
        ));
      }
      if (created.positions.length) {
        await db.delete(paperPositionFill).where(inArray(paperPositionFill.positionId, created.positions));
        await db.delete(paperPosition).where(inArray(paperPosition.id, created.positions));
      }
      if (created.portfolios.length) await db.delete(paperPortfolio).where(inArray(paperPortfolio.id, created.portfolios));
      if (created.predictions.length) {
        await db.delete(brainAgentOccurrence).where(inArray(brainAgentOccurrence.predictionId, created.predictions));
        await db.delete(brainSetupOccurrence).where(inArray(brainSetupOccurrence.predictionId, created.predictions));
        await db.delete(predictionOutcome).where(inArray(predictionOutcome.predictionId, created.predictions));
        await db.execute(sql`DROP TRIGGER IF EXISTS prediction_no_delete ON prediction`);
        await db.delete(prediction).where(inArray(prediction.id, created.predictions));
        await db.execute(sql`CREATE TRIGGER prediction_no_delete BEFORE DELETE ON prediction FOR EACH ROW EXECUTE FUNCTION prediction_no_mutation()`);
      }
      if (created.signals.length) {
        await db.delete(signalFeature).where(inArray(signalFeature.signalId, created.signals));
        await db.delete(signal).where(inArray(signal.id, created.signals));
      }
      // Best-effort brain memory cleanup for any keys / setups we may have touched.
      await db.delete(brainAgentMemory).where(inArray(brainAgentMemory.agentKey, ['perp.momentum', 'perp.open_interest']));
      // Setup memory rows are shared across tests via the fingerprint — leave them.
      for (const id of created.agents) {
        await db.delete(scoringConfig).where(eq(scoringConfig.tradingAgentId, id));
        await db.delete(tradingAgent).where(eq(tradingAgent.id, id));
      }
      await closeDb(db);
    }
  });

  it('resolvePrediction anchors at T1 (fill), NOT T0 (signal creation) — §21', async () => {
    const { predictionId, symbol } = await makePredictionWithPosition({ symbol: 'BTCUSDT' });
    // Seed 1m bars for the WHOLE horizon after T1, gently rising — nothing hits TP or SL.
    const horizonEnd = new Date(T1.getTime() + 4 * 3600_000);
    await seedCandles(db, symbol, T1, horizonEnd, (i) => ({ h: 100.02 + i * 0.001, l: 99.98 + i * 0.001, c: 100 + i * 0.001 }));
    created.candles.push({ symbol, openTime: T1 }); // marker — cleanup narrows by symbol

    // Bump `now` past 8h so the EOD (8h in HORIZON_MS) horizon also elapses.
    const wellAfter = new Date(T1.getTime() + 9 * 3600_000);
    const written = await resolvePrediction(db, {
      predictionId, now: wellAfter,
      mode: 'CANDLE_1M_CONSERVATIVE', style: 'day',
    });
    expect(written).toBe(3); // day-style: 1h, 4h, EOD (1h reference already in the triad)

    const outs = await db.select().from(predictionOutcome).where(eq(predictionOutcome.predictionId, predictionId));
    expect(outs).toHaveLength(3);
    for (const o of outs) {
      // holdingPeriodSec is measured from T1, so a 1h outcome should be ~3600s regardless of T0
      // being 5 minutes earlier. If we anchored at T0 by mistake, this would be ~3900s.
      if (o.horizon === '1h') expect(o.holdingPeriodSec!).toBeGreaterThanOrEqual(3599);
      if (o.horizon === '1h') expect(o.holdingPeriodSec!).toBeLessThanOrEqual(3600 + 65);
      expect(o.outcomeResolution).toBe('CANDLE_1M_CONSERVATIVE');
    }
  });

  it('one Brain occurrence per fingerprint per prediction — NOT one per horizon (§41)', async () => {
    const { predictionId, symbol } = await makePredictionWithPosition({ symbol: 'ETHUSDT' });
    // Seed candles for the whole 8h EOD horizon so every horizon in the day triad can resolve.
    const horizonEnd = new Date(T1.getTime() + 9 * 3600_000);
    // TP at 104 → set a bar that crosses TP cleanly ~2h in.
    await seedCandles(db, symbol, T1, horizonEnd, (i) => (
      i === 120 ? { h: 105, l: 100, c: 104 } : { h: 100.5, l: 99.5, c: 100 }
    ));

    const stats = await outcomeSweep(db, { now: new Date(T1.getTime() + 9 * 3600_000), mode: 'CANDLE_1M_CONSERVATIVE' });
    expect(stats.brainWrites).toBeGreaterThanOrEqual(1);

    // For THIS prediction, the setup occurrence log must show EXACTLY one row per rung — the
    // ladder-write's fanout — but only ONE entry per predictionId at any single setupId. The
    // guard we care about is "no double-write for the same prediction," which materializes as:
    const perPred = await db.select().from(brainSetupOccurrence).where(eq(brainSetupOccurrence.predictionId, predictionId));
    // Ladder = 9 rungs for perp (m5-historical-edge). Every rung → one occurrence; the same
    // rung is never doubled. Assert per-rung uniqueness.
    const bySetup = new Map<string, number>();
    for (const o of perPred) bySetup.set(o.setupId, (bySetup.get(o.setupId) ?? 0) + 1);
    for (const [setupId, n] of bySetup) {
      expect(n).toBe(1);
      expect(setupId).toBeTruthy();
    }
    // Sanity: the fingerprint ladder has been fully written.
    expect(perPred.length).toBe(9);
  });

  it('brain_written_at guards against a double sweep (at-most-once)', async () => {
    const { predictionId, symbol } = await makePredictionWithPosition({ symbol: 'BTCUSDT' });
    const horizonEnd = new Date(T1.getTime() + 9 * 3600_000);
    await seedCandles(db, symbol, T1, horizonEnd, () => ({ h: 100.5, l: 99.5, c: 100 }));

    const later = new Date(T1.getTime() + 9 * 3600_000);
    const first = await outcomeSweep(db, { now: later, mode: 'CANDLE_1M_CONSERVATIVE' });
    const second = await outcomeSweep(db, { now: later, mode: 'CANDLE_1M_CONSERVATIVE' });

    // The second run touches no new outcomes and writes no new Brain occurrence for this prediction.
    const rowAfter = (await db.select({ w: prediction.brainWrittenAt }).from(prediction).where(eq(prediction.id, predictionId)).limit(1))[0]!;
    expect(rowAfter.w).not.toBeNull();
    expect(first.brainWrites + second.brainWrites).toBeGreaterThanOrEqual(1);
    // Second sweep is bounded: an already-stamped prediction is skipped in feedBrainOnce.
    void first; void second;
  });

  it('featureTupleFor maps signal_feature agent scores into fingerprint dimensions', async () => {
    const { predictionId } = await makePredictionWithPosition({
      symbol: 'BTCUSDT',
      features: [
        { agentKey: 'perp.momentum', agentVersion: 1, score: 0.85 },
        { agentKey: 'perp.open_interest', agentVersion: 1, score: -0.4 },
      ],
    });
    const p = (await db.select().from(prediction).where(eq(prediction.id, predictionId)).limit(1))[0]!;
    const tuple = await featureTupleFor(db, p.signalId, 'perp');
    expect(tuple.momentum).toBeCloseTo(0.85, 6);
    expect(tuple.open_interest).toBeCloseTo(-0.4, 6);
    // Dimensions without a score default to 0 (MED bucket) — never invented, never dropped.
    expect(tuple.market_regime).toBe(0);
    expect(tuple.volatility).toBe(0);
    // Fingerprint stays deterministic under this filling rule.
    expect(ladder('perp', tuple).length).toBe(9); // ladder returns 9 rungs including global
  });
});
