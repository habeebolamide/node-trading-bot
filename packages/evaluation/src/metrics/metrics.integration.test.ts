import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import {
  createDb, closeDb,
  prediction, predictionOutcome, scoringConfig, signal, signalFeature, tradingAgent,
  type Db,
} from '@tip/database';
import { createTradingAgent } from '@tip/trading-agents';
import { factorPredictiveValue } from './attribution.js';
import { headlineMetrics, byHorizon, isBootstrapping, precisionRecall } from './metrics.js';

const DATABASE_URL = process.env.DATABASE_URL;
const T0 = new Date('2026-06-01T00:00:00Z');
const ASOF = new Date('2026-09-01T00:00:00Z');

const perpConfig = {
  riskPercent: 0.01, minRR: 1.5, maxConcurrentPositions: 2, leverageMax: 10,
  agentWeights: { 'perp.momentum': 1 },
  confidenceWeights: { signalStrength: 0.3, agentAgreement: 0.3, historicalEvidence: 0.25, dataQuality: 0.15 },
  signalThresholds: { strongLong: 0.7, long: 0.45, weakLong: 0.2, weakShort: -0.2, short: -0.45, strongShort: -0.7 },
};

describe.skipIf(!DATABASE_URL)('metrics (integration)', () => {
  let db: Db;
  let agentId: string;
  const created = { signals: [] as string[], predictions: [] as string[], agents: [] as string[] };

  /**
   * Seed one signal + prediction + outcome for the given (configVersion, momentumScore, won).
   * A helper because every test in this file wants the same tuple shape.
   */
  async function seedResolvedPrediction(input: {
    configVersion: number; momentumScore: number; won: boolean;
    returnPct: number; alpha?: number | null; confidence?: number; createdAt?: Date;
  }): Promise<string> {
    const sigId = randomUUID(); created.signals.push(sigId);
    await db.insert(signal).values({
      id: sigId, tradingAgentId: agentId, symbol: 'BTCUSDT', domain: 'perp',
      direction: 'LONG', compositeScore: String(input.momentumScore), confidence: String(input.confidence ?? 0.7),
      state: 'CONSUMED', createdAt: input.createdAt ?? T0, expiresAt: new Date((input.createdAt ?? T0).getTime() + 60_000),
      configVersion: input.configVersion, fingerprint: `am-${randomUUID().slice(0, 8)}`, evidence: {},
    });
    await db.insert(signalFeature).values({
      signalId: sigId, agentKey: 'perp.momentum', agentVersion: 1,
      score: String(input.momentumScore), confidence: '0.7', features: {},
    });
    const predId = randomUUID(); created.predictions.push(predId);
    await db.insert(prediction).values({
      id: predId, tradingAgentId: agentId, signalId: sigId, domain: 'perp', symbol: 'BTCUSDT',
      direction: 'LONG', score: String(input.momentumScore), confidence: String(input.confidence ?? 0.7),
      horizon: '4h', entry: '100', stopLoss: '98', takeProfit: '104',
      positionSize: '1', notional: '100', leverage: '5', requiredMargin: '20',
      riskReward: '2', features: [], configVersion: input.configVersion, createdAt: input.createdAt ?? T0,
    });
    await db.insert(predictionOutcome).values({
      predictionId: predId, horizon: '4h',
      resolvedAt: new Date((input.createdAt ?? T0).getTime() + 4 * 3600_000),
      returnPct: String(input.returnPct),
      benchmarkReturnPct: input.alpha === null || input.alpha === undefined ? null : String(input.returnPct - input.alpha),
      alpha: input.alpha === null || input.alpha === undefined ? null : String(input.alpha),
      mfe: '0.02', mae: '-0.01',
      hitTarget: input.won, hitInvalidation: !input.won,
      holdingPeriodSec: 3600, won: input.won,
      outcomeResolution: 'TICK',
    });
    return predId;
  }

  beforeAll(async () => {
    db = createDb(DATABASE_URL!);
    const a = await createTradingAgent(db, {
      name: `AM-${randomUUID().slice(0, 6)}`, domain: 'perp', universe: ['BTCUSDT'], tradingStyle: 'day', config: perpConfig,
    });
    agentId = a.id; created.agents.push(agentId);
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

  // Use unique high-numbered configVersions per test — every tradingAgent starts at v1 by
  // default, so filtering by `configVersion: 1` picks up rows from parallel test files. High
  // versions (500+) are effectively private, keeping this file's assertions independent of
  // whatever else is running.
  const V_HEADLINE = 510;
  const V_ISOLATION_V1 = 511;
  const V_ISOLATION_V2 = 512;
  const V_HORIZON = 513;
  const V_BOOTSTRAP = 510; // shares with HEADLINE — this test wants that
  it('headlineMetrics: null on empty, populated once outcomes exist', async () => {
    // A brand-new configVersion nobody has resolved anything for → null.
    expect(await headlineMetrics(db, { domain: 'perp', configVersion: 9999, horizon: '4h', asOf: ASOF })).toBeNull();

    for (let i = 0; i < 5; i++) await seedResolvedPrediction({
      configVersion: V_HEADLINE, momentumScore: 0.5, won: i < 4, returnPct: i < 4 ? 0.05 : -0.02, alpha: i < 4 ? 0.03 : -0.01,
    });
    const m = await headlineMetrics(db, { domain: 'perp', configVersion: V_HEADLINE, horizon: '4h', asOf: ASOF });
    expect(m).not.toBeNull();
    expect(m!.n).toBeGreaterThanOrEqual(5);
    expect(m!.accuracy).toBeGreaterThan(0.5);
    expect(m!.wilsonLower).not.toBeNull();
    expect(m!.wilsonUpper!).toBeGreaterThan(m!.wilsonLower!);
  });

  it('VERSION ISOLATION: v1 and v2 metrics NEVER merge; no all-versions accessor exists', async () => {
    // A strongly-winning v1 and a strongly-losing v2 — the point is that v2's metrics never
    // include v1's winners even though they're the same agent + domain.
    for (let i = 0; i < 15; i++) await seedResolvedPrediction({
      configVersion: V_ISOLATION_V1, momentumScore: 0.5, won: true, returnPct: 0.05, alpha: 0.03,
    });
    for (let i = 0; i < 8; i++) await seedResolvedPrediction({
      configVersion: V_ISOLATION_V2, momentumScore: 0.5, won: false, returnPct: -0.03, alpha: -0.02,
    });

    const v1 = await headlineMetrics(db, { domain: 'perp', configVersion: V_ISOLATION_V1, horizon: '4h', asOf: ASOF });
    const v2 = await headlineMetrics(db, { domain: 'perp', configVersion: V_ISOLATION_V2, horizon: '4h', asOf: ASOF });
    expect(v1!.accuracy!).toBeGreaterThan(v2!.accuracy!);
    expect(v2!.accuracy).toBe(0);
    // Compile-time check: no `all-versions` reader exists — attempting to import one fails.
    const mod = await import('./metrics.js');
    for (const name of Object.keys(mod)) {
      expect(name).not.toMatch(/allVersions|blend|combined/i);
    }
  });

  it('byHorizon returns one row per horizon that has resolved rows', async () => {
    // A fresh version so parallel files' 1h outcomes cannot contaminate the "no 1h" assertion.
    for (let i = 0; i < 3; i++) await seedResolvedPrediction({
      configVersion: V_HORIZON, momentumScore: 0.4, won: true, returnPct: 0.02, alpha: 0.01,
    });
    const rows = await byHorizon(db, { domain: 'perp', configVersion: V_HORIZON, asOf: ASOF, horizons: ['1h', '4h', 'EOD'] });
    // Only 4h outcomes were seeded; 1h and EOD reads must not fabricate.
    const horizons = rows.map((r) => r.horizon);
    expect(horizons).toContain('4h');
    expect(horizons).not.toContain('1h');
    expect(horizons).not.toContain('EOD');
  });

  it('isBootstrapping surfaces the §32 bootstrap-window state explicitly', async () => {
    const early = await isBootstrapping(db, { domain: 'perp', configVersion: V_BOOTSTRAP, horizon: '4h', asOf: ASOF, minN: 999 });
    expect(early.bootstrapping).toBe(true);
    expect(early.message).toContain('bootstrapping');

    const enough = await isBootstrapping(db, { domain: 'perp', configVersion: V_BOOTSTRAP, horizon: '4h', asOf: ASOF, minN: 1 });
    expect(enough.bootstrapping).toBe(false);
    expect(enough.message).toContain('sufficient');
  });

  it('factorPredictiveValue: separated Wilson intervals → measurable difference', async () => {
    // A CONFIG WHERE MOMENTUM MATTERS: seed lots of high-contribution winners and low-contribution
    // losers under a fresh configVersion so the tertile cuts fall cleanly and Wilson intervals
    // don't overlap. This is the mechanism §22 asks for: "which factors had predictive value."
    const cv = 100;
    for (let i = 0; i < 15; i++) await seedResolvedPrediction({ configVersion: cv, momentumScore: 0.9, won: true, returnPct: 0.05 });
    for (let i = 0; i < 15; i++) await seedResolvedPrediction({ configVersion: cv, momentumScore: -0.9, won: false, returnPct: -0.05 });

    const fpv = await factorPredictiveValue(db, {
      domain: 'perp', agentKey: 'perp.momentum', configVersion: cv, asOf: ASOF, horizon: '4h',
    });
    expect(fpv).not.toBeNull();
    expect(fpv!.evidence).toBe('SUFFICIENT');
    expect(fpv!.measurableDifference).toBe(true);
    expect(fpv!.byTertile.HIGH.winRate!).toBeGreaterThan(fpv!.byTertile.LOW.winRate!);
    expect(fpv!.byTertile.HIGH.wilsonLower!).toBeGreaterThan(fpv!.byTertile.LOW.wilsonUpper!);
  });

  it('factorPredictiveValue: overlapping intervals → "no measurable difference" (NOT a small effect)', async () => {
    // A CONFIG WHERE MOMENTUM DOES NOT SEPARATE OUTCOMES: interleave wins and losses across
    // both high and low contributions, so the intervals overlap and the honest answer is "no".
    const cv = 200;
    // 8 high-contribution wins + 7 high-contribution losses; same 8/7 for low. Intervals broad + overlapping.
    for (let i = 0; i < 15; i++) await seedResolvedPrediction({ configVersion: cv, momentumScore: 0.9, won: i < 8, returnPct: i < 8 ? 0.02 : -0.01 });
    for (let i = 0; i < 15; i++) await seedResolvedPrediction({ configVersion: cv, momentumScore: -0.9, won: i < 7, returnPct: i < 7 ? 0.02 : -0.01 });

    const fpv = await factorPredictiveValue(db, {
      domain: 'perp', agentKey: 'perp.momentum', configVersion: cv, asOf: ASOF, horizon: '4h',
    });
    expect(fpv).not.toBeNull();
    expect(fpv!.measurableDifference).toBe(false);
    expect(fpv!.summary).toBe('no measurable difference');
  });

  it('precisionRecall — sane math and null-guards', () => {
    expect(precisionRecall({ tp: 8, fp: 2, fn: 2 }).precision).toBeCloseTo(0.8, 6);
    expect(precisionRecall({ tp: 8, fp: 2, fn: 2 }).recall).toBeCloseTo(0.8, 6);
    expect(precisionRecall({ tp: 0, fp: 0, fn: 0 }).precision).toBeNull();
  });
});
