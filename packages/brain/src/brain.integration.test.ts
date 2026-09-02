import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { inArray } from 'drizzle-orm';
import { createDb, closeDb, brainSetupMemory, brainSetupOccurrence, brainTokenMemory, type Db } from '@tip/database';
import { ValidationError } from '@tip/domain';
import { createBrain, BRAIN_ASOF_ENFORCED } from './brain.js';
import { ladder } from './backoff.js';
import type { FeatureTuple } from './fingerprint.js';
import { recordSetupOutcome } from './setup-memory.js';
import { upsertTokenMemory, tokenOutcomes } from './token-memory.js';

const DATABASE_URL = process.env.DATABASE_URL;
const T = new Date('2026-07-01T00:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

describe.skipIf(!DATABASE_URL)('Brain facade (integration, Postgres)', () => {
  let db: Db;
  const touched = new Set<string>();
  const predictionIds: string[] = [];
  const mints: string[] = [];

  const bullish: FeatureTuple = {
    smart_money: 0.9, convergence: 0.9, momentum: 0.9, token_quality: 0.9, market_regime: 0.9,
  };
  const bearish: FeatureTuple = { ...bullish, market_regime: -0.9 };

  async function feed(f: FeatureTuple, n: number, wins: number) {
    for (let i = 0; i < n; i++) {
      const predictionId = randomUUID();
      predictionIds.push(predictionId);
      await recordSetupOutcome(db, {
        predictionId, domain: 'memecoin', features: f, closedAt: T,
        won: i < wins, returnPct: i < wins ? 0.6 : -0.3,
      });
    }
    for (const r of ladder('memecoin', f)) touched.add(r.setupId);
  }

  beforeAll(() => { db = createDb(DATABASE_URL!); });
  afterAll(async () => {
    if (db) {
      if (predictionIds.length) await db.delete(brainSetupOccurrence).where(inArray(brainSetupOccurrence.predictionId, predictionIds));
      if (touched.size) await db.delete(brainSetupMemory).where(inArray(brainSetupMemory.setupId, [...touched]));
      if (mints.length) await db.delete(brainTokenMemory).where(inArray(brainTokenMemory.mint, mints));
      await closeDb(db);
    }
  });

  it('is created per domain and reports it', () => {
    expect(createBrain(db, 'memecoin').domain).toBe('memecoin');
    expect(createBrain(db, 'perp').domain).toBe('perp');
  });

  it('a perp Brain THROWS on wallet/token — a bug, not an empty result (§15 domain separation)', async () => {
    const perp = createBrain(db, 'perp');
    await expect(perp.wallet('anything', T)).rejects.toThrow(ValidationError);
    await expect(perp.token('anything', T)).rejects.toThrow(/memecoin-only/);
  });

  it('a memecoin Brain serves wallet and token reads', async () => {
    const brain = createBrain(db, 'memecoin');
    const w = await brain.wallet(`W-${randomUUID().slice(0, 8)}`, T);
    expect(w.behavior.rated).toBe(false); // no trades
    expect(await brain.token(`nonexistent-${randomUUID().slice(0, 8)}`, T)).toBeNull();
  });

  it('token reads round-trip through the facade', async () => {
    const mint = `MINT-${randomUUID().slice(0, 8)}`;
    mints.push(mint);
    await upsertTokenMemory(db, {
      mint, profile: { liquidityUsd: 50_000, top10HolderPct: 0.12 },
      score: 0.82, outcomes: tokenOutcomes(8, 12, 0.4), asOf: T,
    });
    const t = await createBrain(db, 'memecoin').token(mint, T);
    expect(t!.score).toBeCloseTo(0.82, 6);
    expect(t!.evidence).toBe('SUFFICIENT');
    expect(t!.outcomes!.winRate).toBeCloseTo(8 / 12, 6);
  });

  it('setup() delegates to the Historical Edge read', async () => {
    // An exact cell nothing has written reports INSUFFICIENT. The SCORE is deliberately not
    // asserted to be 0: once the domain's global rung has history (which the rest of the suite
    // supplies), an unknown fingerprint correctly falls all the way back to the global base rate
    // and contributes a heavily-attenuated but non-zero value — 0.5^5 at the memecoin ladder's
    // depth. Asserting 0 here would only hold on a virgin database.
    const f: FeatureTuple = { smart_money: -0.9, convergence: -0.9, momentum: -0.9, token_quality: -0.9, market_regime: -0.9 };
    const edge = await createBrain(db, 'memecoin').setup(f, T);
    expect(edge.evidence).toBe('INSUFFICIENT');
    expect(Math.abs(edge.score)).toBeLessThan(0.05); // near-zero, per §40.16's edge case
    expect(edge).toHaveProperty('backoffDepth');
    expect(edge).toHaveProperty('historicalEvidence');
  });

  /**
   * Market Memory is DOMAIN-GLOBAL by construction — it groups every setup in the domain by its
   * regime dimension. It therefore sees whatever the rest of the suite has written to the same
   * shared database, so these assert DELTAS and structure rather than absolute counts. That is a
   * property of the feature, not a weakness of the test: any "how do setups behave in bull
   * markets" answer is necessarily global.
   */
  it('market() splits outcomes by regime bucket — the regime dimension does the work, not a table', async () => {
    const brain = createBrain(db, 'memecoin');
    const before = await brain.market(T);
    const baseHigh = before.byRegime.find((r) => r.regime === 'HIGH')!.effectiveN;
    const baseLow = before.byRegime.find((r) => r.regime === 'LOW')!.effectiveN;
    const baseMed = before.byRegime.find((r) => r.regime === 'MED')!.effectiveN;

    await feed(bullish, 12, 10); // HIGH regime bucket
    await feed(bearish, 12, 3);  // LOW regime bucket

    const after = await brain.market(T);
    expect(after.byRegime).toHaveLength(3);
    const high = after.byRegime.find((r) => r.regime === 'HIGH')!;
    const low = after.byRegime.find((r) => r.regime === 'LOW')!;
    const med = after.byRegime.find((r) => r.regime === 'MED')!;

    // This file's 12 bullish + 12 bearish fixtures are visible in their own buckets. The delta
    // is asserted as a LOWER BOUND, not an equality: vitest runs test files in parallel against
    // one database, so another file can add to a bucket between the two reads. The stronger
    // claim — that a setup lands in exactly ONE regime bucket — is a property of the id sets and
    // is asserted directly in market-memory.test.ts, immune to concurrency.
    expect(high.effectiveN - baseHigh).toBeGreaterThanOrEqual(12 - 1e-6);
    expect(low.effectiveN - baseLow).toBeGreaterThanOrEqual(12 - 1e-6);
    void baseMed; void med;

    expect(high.evidence).toBe('SUFFICIENT');
    expect(high.wilsonLower).not.toBeNull();
    expect(high.wilsonLower!).toBeLessThan(high.winRate!);
  });

  it('market() is point-in-time — an earlier asOf cannot see occurrences that close later', async () => {
    const brain = createBrain(db, 'memecoin');
    // A ONE-DAY gap, not one second. Two effects fight each other across two asOf values:
    // the later read GAINS occurrences that closed in between, and it LOSES a little weight on
    // everything older (one more day of decay). With a one-second gap the decay drift on a large
    // pre-existing bucket (~1e-5) can exceed the gain and invert the comparison; with a day, this
    // file's own 12 fixtures dominate by six orders of magnitude.
    const before = await brain.market(new Date(T.getTime() - DAY_MS));
    const at = await brain.market(T);
    // This file's 12 bullish fixtures close AT T and are invisible a day earlier. The delta is
    // "12 minus a day of decay on everything already in the HIGH bucket" — and that decay term
    // grows with the shared DB. Assert the invariant (adding 12 raises the count by MOST of 12)
    // rather than pinning a number that drifts as other test files add fixtures.
    const highBefore = before.byRegime.find((r) => r.regime === 'HIGH')!;
    const highAt = at.byRegime.find((r) => r.regime === 'HIGH')!;
    expect(highAt.effectiveN - highBefore.effectiveN).toBeGreaterThan(10);
  });

  it('the asOf compile-time guard is present (rule 21 enforced structurally, not by convention)', () => {
    // The real enforcement is in the type system — `npm run typecheck` fails if any Brain read
    // stops requiring `asOf`. This asserts the guard is wired, so deleting it is visible here too.
    expect(BRAIN_ASOF_ENFORCED).toBe(true);
  });
});
