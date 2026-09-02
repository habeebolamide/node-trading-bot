import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import {
  createDb, closeDb, prediction, predictionOutcome, signal, signalNoTrade, tradingAgent, scoringConfig,
  type Db,
} from '@tip/database';
import type { TradeSetup } from '@tip/planner';
import { createTradingAgent } from '@tip/trading-agents';
import { createPrediction } from './create.js';
import { recordNoTrade } from './no-trade.js';
import { getPrediction, listPredictions } from './read.js';

const DATABASE_URL = process.env.DATABASE_URL;

const perpConfig = {
  riskPercent: 0.01, minRR: 1.5, maxConcurrentPositions: 2, leverageMax: 10,
  agentWeights: { 'perp.momentum': 1 },
  confidenceWeights: { signalStrength: 0.3, agentAgreement: 0.3, historicalEvidence: 0.25, dataQuality: 0.15 },
  signalThresholds: { strongLong: 0.7, long: 0.45, weakLong: 0.2, weakShort: -0.2, short: -0.45, strongShort: -0.7 },
};

describe.skipIf(!DATABASE_URL)('createPrediction (integration, Postgres)', () => {
  let db: Db;
  let agentId: string;
  const createdSignals: string[] = [];
  const createdPredictions: string[] = [];
  const createdAgents: string[] = [];

  const setup = (over: Partial<TradeSetup> = {}): TradeSetup => ({
    symbol: 'BTCUSDT', domain: 'perp', direction: 'LONG', entryType: 'MARKET',
    entry: 100, stopLoss: 98, takeProfit: 104, riskReward: 2,
    positionSize: 5, notional: 500,
    leverage: 5, requiredMargin: 100,
    horizon: '4h', plannedAt: new Date(), configVersion: 1,
    ...over,
  });

  async function makeActiveSignal(direction = 'LONG'): Promise<string> {
    const id = randomUUID();
    createdSignals.push(id);
    await db.insert(signal).values({
      id, tradingAgentId: agentId, symbol: 'BTCUSDT', domain: 'perp',
      direction, compositeScore: '0.6', confidence: '0.7',
      state: 'ACTIVE', createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
      configVersion: 1, fingerprint: `pred-${randomUUID().slice(0, 8)}`, evidence: {},
    });
    return id;
  }

  beforeAll(async () => {
    db = createDb(DATABASE_URL!);
    const a = await createTradingAgent(db, {
      name: `PRED-${randomUUID().slice(0, 6)}`, domain: 'perp', universe: ['BTCUSDT'], tradingStyle: 'day', config: perpConfig,
    });
    agentId = a.id;
    createdAgents.push(agentId);
  });

  afterAll(async () => {
    if (db) {
      if (createdPredictions.length) {
        await db.delete(predictionOutcome).where(inArray(predictionOutcome.predictionId, createdPredictions));
        // The trigger blocks DELETE by design (rule 10 — the whole point of migration 0012). For
        // test-only cleanup, temporarily DROP the DELETE trigger, delete, restore. Any table
        // owner can do this, unlike SET session_replication_role which needs superuser.
        await db.execute(sql`DROP TRIGGER IF EXISTS prediction_no_delete ON prediction`);
        await db.delete(prediction).where(inArray(prediction.id, createdPredictions));
        await db.execute(sql`CREATE TRIGGER prediction_no_delete BEFORE DELETE ON prediction FOR EACH ROW EXECUTE FUNCTION prediction_no_mutation()`);
      }
      if (createdSignals.length) {
        await db.delete(signalNoTrade).where(inArray(signalNoTrade.signalId, createdSignals));
        await db.delete(signal).where(inArray(signal.id, createdSignals));
      }
      for (const id of createdAgents) {
        await db.delete(scoringConfig).where(eq(scoringConfig.tradingAgentId, id));
        await db.delete(tradingAgent).where(eq(tradingAgent.id, id));
      }
      await closeDb(db);
    }
  });

  it('CREATE happy path — inserts prediction, moves signal to CONSUMED atomically', async () => {
    const sig = await makeActiveSignal();
    const out = await createPrediction(db, {
      signalId: sig, tradingAgentId: agentId, setup: setup(),
      signalScore: 0.6, confidence: 0.7, direction: 'LONG',
      features: [{ agent: 'perp.momentum', agentVersion: 1, contribution: 0.6, weight: 1, score: 0.6 }],
    });
    expect(out.created).toBe(true);
    if (!out.created) return;
    createdPredictions.push(out.prediction.id);
    expect(out.prediction.configVersion).toBe(1);
    expect(out.prediction.horizon).toBe('4h');

    const state = (await db.select({ state: signal.state }).from(signal).where(eq(signal.id, sig)).limit(1))[0]!.state;
    expect(state).toBe('CONSUMED');
  });

  it('IMMUTABILITY: the trigger raises on UPDATE of a prediction (rule 10)', async () => {
    const sig = await makeActiveSignal();
    const out = await createPrediction(db, {
      signalId: sig, tradingAgentId: agentId, setup: setup(),
      signalScore: 0.6, confidence: 0.7, direction: 'LONG',
      features: [], invalidators: [], thesis: 'original',
    });
    if (!out.created) throw new Error('setup failed');
    createdPredictions.push(out.prediction.id);

    await expect(
      db.update(prediction).set({ thesis: 'edited' }).where(eq(prediction.id, out.prediction.id))
    ).rejects.toThrow(/INSERT-only|rule 10/i);
  });

  it('IMMUTABILITY: the trigger raises on DELETE of a prediction (rule 10)', async () => {
    const sig = await makeActiveSignal();
    const out = await createPrediction(db, {
      signalId: sig, tradingAgentId: agentId, setup: setup(),
      signalScore: 0.6, confidence: 0.7, direction: 'LONG', features: [],
    });
    if (!out.created) throw new Error('setup failed');
    createdPredictions.push(out.prediction.id);

    await expect(
      db.delete(prediction).where(eq(prediction.id, out.prediction.id))
    ).rejects.toThrow(/INSERT-only|rule 10/i);
  });

  it('REAL CONCURRENCY: two callers on one ACTIVE signal → exactly ONE prediction (§29 pattern)', async () => {
    const sig = await makeActiveSignal();
    const [a, b] = await Promise.all([
      createPrediction(db, {
        signalId: sig, tradingAgentId: agentId, setup: setup(),
        signalScore: 0.6, confidence: 0.7, direction: 'LONG', features: [],
      }),
      createPrediction(db, {
        signalId: sig, tradingAgentId: agentId, setup: setup(),
        signalScore: 0.6, confidence: 0.7, direction: 'LONG', features: [],
      }),
    ]);
    const created = [a, b].filter((r) => r.created);
    const rejected = [a, b].filter((r) => !r.created);
    expect(created).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    if (created[0]!.created) createdPredictions.push(created[0]!.prediction.id);

    // The rejected one bailed on either DUPLICATE_SIGNAL or SIGNAL_NOT_ACTIVE (CONSUMED) —
    // both are correct outcomes of a lost race and either preserves the invariant.
    if (!rejected[0]!.created) {
      expect(['DUPLICATE_SIGNAL', 'SIGNAL_NOT_ACTIVE']).toContain(rejected[0]!.reason);
    }
  });

  it('refuses an INVALIDATED signal — SIGNAL_NOT_ACTIVE', async () => {
    const sig = await makeActiveSignal();
    await db.update(signal).set({ state: 'INVALIDATED' }).where(eq(signal.id, sig));
    const out = await createPrediction(db, {
      signalId: sig, tradingAgentId: agentId, setup: setup(),
      signalScore: 0.6, confidence: 0.7, direction: 'LONG', features: [],
    });
    expect(out.created).toBe(false);
    if (!out.created) {
      expect(out.reason).toBe('SIGNAL_NOT_ACTIVE');
      if ('currentState' in out) expect(out.currentState).toBe('INVALIDATED');
    }
  });

  it('refuses an EXPIRED signal — SIGNAL_NOT_ACTIVE', async () => {
    const sig = await makeActiveSignal();
    await db.update(signal).set({ state: 'EXPIRED' }).where(eq(signal.id, sig));
    const out = await createPrediction(db, {
      signalId: sig, tradingAgentId: agentId, setup: setup(),
      signalScore: 0.6, confidence: 0.7, direction: 'LONG', features: [],
    });
    expect(out.created).toBe(false);
    if (!out.created) expect(out.reason).toBe('SIGNAL_NOT_ACTIVE');
  });

  it('read helpers round-trip; features JSON survives', async () => {
    const sig = await makeActiveSignal();
    const features = [
      { agent: 'perp.momentum', agentVersion: 1, contribution: 0.5, weight: 0.5, score: 1 },
      { agent: 'perp.funding', agentVersion: 1, contribution: 0.1, weight: 0.5, score: 0.2 },
    ];
    const out = await createPrediction(db, {
      signalId: sig, tradingAgentId: agentId, setup: setup(),
      signalScore: 0.6, confidence: 0.7, direction: 'LONG', features,
    });
    if (!out.created) throw new Error('setup failed');
    createdPredictions.push(out.prediction.id);

    const single = await getPrediction(db, out.prediction.id);
    expect(single?.entry).toBeCloseTo(100, 10);
    expect(single?.leverage).toBeCloseTo(5, 10);
    expect((single?.features as typeof features)[0]!.agent).toBe('perp.momentum');

    const listed = await listPredictions(db, { tradingAgentId: agentId, limit: 100 });
    expect(listed.find((p) => p.id === out.prediction.id)).toBeDefined();
  });

  it('shadow row: isShadow + shadowOf round-trip (M7 populates)', async () => {
    const sig1 = await makeActiveSignal();
    const orig = await createPrediction(db, {
      signalId: sig1, tradingAgentId: agentId, setup: setup(),
      signalScore: 0.6, confidence: 0.7, direction: 'LONG', features: [],
    });
    if (!orig.created) throw new Error('setup failed');
    createdPredictions.push(orig.prediction.id);

    const sig2 = await makeActiveSignal();
    const shadow = await createPrediction(db, {
      signalId: sig2, tradingAgentId: agentId, setup: setup({ direction: 'SHORT', stopLoss: 102, takeProfit: 96 }),
      signalScore: -0.6, confidence: 0.6, direction: 'SHORT', features: [],
      isShadow: true, shadowOf: orig.prediction.id,
    });
    if (!shadow.created) throw new Error('shadow failed');
    createdPredictions.push(shadow.prediction.id);
    expect(shadow.prediction.isShadow).toBe(true);
    expect(shadow.prediction.shadowOf).toBe(orig.prediction.id);
  });

  it('recordNoTrade writes the veto and marks the signal INVALIDATED (§36)', async () => {
    const sig = await makeActiveSignal();
    await recordNoTrade(db, { signalId: sig, reason: 'INSUFFICIENT_RR', detail: 'R:R 1.2 < 1.5' });

    const veto = (await db.select().from(signalNoTrade).where(eq(signalNoTrade.signalId, sig)).limit(1))[0];
    expect(veto?.reason).toBe('INSUFFICIENT_RR');
    expect(veto?.detail).toContain('1.2');

    const state = (await db.select({ state: signal.state }).from(signal).where(eq(signal.id, sig)).limit(1))[0]!.state;
    expect(state).toBe('INVALIDATED');

    // No Prediction was created — that's the whole point of the resolution.
    const preds = await listPredictions(db, { tradingAgentId: agentId, limit: 200 });
    expect(preds.find((p) => p.signalId === sig)).toBeUndefined();
  });

  it('recordNoTrade is idempotent — re-vetoed signal keeps the first reason', async () => {
    const sig = await makeActiveSignal();
    await recordNoTrade(db, { signalId: sig, reason: 'INSUFFICIENT_RR', detail: 'first' });
    await recordNoTrade(db, { signalId: sig, reason: 'CANNOT_SIZE_SAFELY', detail: 'second' });
    const veto = (await db.select().from(signalNoTrade).where(eq(signalNoTrade.signalId, sig)).limit(1))[0];
    expect(veto?.reason).toBe('INSUFFICIENT_RR');
  });
});
