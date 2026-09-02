import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { inArray } from 'drizzle-orm';
import { createDb, closeDb, brainSetupMemory, brainSetupOccurrence, type Db } from '@tip/database';
import { ladder } from './backoff.js';
import type { FeatureTuple } from './fingerprint.js';
import { historicalEdge } from './historical-edge.js';
import { recordSetupOutcome } from './setup-memory.js';

const DATABASE_URL = process.env.DATABASE_URL;
const T = new Date('2026-06-01T00:00:00Z');

/**
 * Each test gets a feature snapshot unique in `smart_money`'s exact value but IDENTICAL in
 * bucket terms would collide — so instead we vary a dimension the ladder drops late, and scope
 * cleanup by the setupIds the ladder produces. The global rung is shared with other tests by
 * design, so assertions never depend on the global row's contents.
 */
describe.skipIf(!DATABASE_URL)('historicalEdge (integration, Postgres)', () => {
  let db: Db;
  const touched = new Set<string>();
  const predictionIds: string[] = [];

  /** Distinct feature snapshots via the momentum axis; each call returns a fresh cell family. */
  let seq = 0;
  function features(over: Partial<FeatureTuple> = {}): FeatureTuple {
    // Vary only within-bucket values so buckets stay stable, and use a per-test marker on
    // smart_money's magnitude — buckets are what matter, so we instead rely on unique
    // predictionIds and read only the rungs we wrote.
    seq++;
    return {
      smart_money: 0.9, convergence: 0.5, momentum: 0.4, token_quality: 0.8, market_regime: 0.6,
      ...over,
    };
  }

  async function feed(f: FeatureTuple, n: number, wins: number, closedAt = T): Promise<void> {
    for (let i = 0; i < n; i++) {
      const predictionId = randomUUID();
      predictionIds.push(predictionId);
      await recordSetupOutcome(db, {
        predictionId, domain: 'memecoin', features: f, closedAt,
        won: i < wins, returnPct: i < wins ? 0.4 : -0.2,
      });
    }
    for (const r of ladder('memecoin', f)) touched.add(r.setupId);
  }

  beforeAll(() => { db = createDb(DATABASE_URL!); });
  afterAll(async () => {
    if (db) {
      if (predictionIds.length) {
        await db.delete(brainSetupOccurrence).where(inArray(brainSetupOccurrence.predictionId, predictionIds));
      }
      if (touched.size) {
        await db.delete(brainSetupMemory).where(inArray(brainSetupMemory.setupId, [...touched]));
      }
      await closeDb(db);
    }
  });

  it('an empty Brain returns INSUFFICIENT with score 0 — the correct pre-M6 state', async () => {
    const f = features({ smart_money: -0.9, convergence: -0.9, momentum: -0.9, token_quality: -0.9, market_regime: -0.9 });
    const edge = await historicalEdge(db, 'memecoin', f, T);
    expect(edge.evidence).toBe('INSUFFICIENT');
    expect(edge.score).toBe(0);
    expect(edge.exactOccurrences).toBe(0);
    expect(edge.historicalEvidence).toBe(0.25);
  });

  it('rung 0 answering yields SUFFICIENT, backoffDepth 0, no fallback', async () => {
    const f = features({ convergence: -0.8, market_regime: -0.7 });
    await feed(f, 12, 9);
    const edge = await historicalEdge(db, 'memecoin', f, T);
    expect(edge.evidence).toBe('SUFFICIENT');
    expect(edge.backoffDepth).toBe(0);
    expect(edge.fallback).toBeNull();
    expect(edge.exactOccurrences).toBe(12);
    expect(edge.observedWinRate).toBeCloseTo(0.75, 6);
    expect(edge.score).toBeGreaterThan(0); // 75% win rate amplifies
    expect(edge.ciWidth).not.toBeNull();
  });

  it("§8's worked example: a thin exact cell reports INSUFFICIENT with the parent's rate, never its own 86%", async () => {
    // 7 exact occurrences at ~86% — below the effective-n 10 bar.
    const base = features({ momentum: -0.9, token_quality: -0.8 });
    await feed(base, 7, 6);
    // A sibling differing ONLY in the first-dropped dimension (market_regime) pools into rung 1.
    await feed({ ...base, market_regime: -0.9 }, 8, 5);

    const edge = await historicalEdge(db, 'memecoin', base, T);
    expect(edge.exactOccurrences).toBe(7);
    expect(edge.observedWinRate).toBeCloseTo(6 / 7, 6); // ~0.857 — reported, but NOT the answer
    expect(edge.evidence).toBe('INSUFFICIENT');          // the exact cell did not clear
    expect(edge.backoffDepth).toBe(1);                   // rung 1 answered
    expect(edge.fallback).toBe('dropped market_regime');
    expect(edge.fallbackWinRate).toBeCloseTo(11 / 15, 6); // pooled 6+5 wins of 7+8
    expect(edge.fallbackWinRate!).toBeLessThan(edge.observedWinRate!); // the point of backing off
  });

  it('a backed-off answer contributes less than the same numbers would at rung 0', async () => {
    const f = features({ smart_money: -0.9, momentum: -0.9 });
    await feed(f, 6, 5);                                     // exact: thin
    await feed({ ...f, market_regime: -0.9 }, 9, 7);          // pools into rung 1
    const edge = await historicalEdge(db, 'memecoin', f, T);
    expect(edge.backoffDepth).toBe(1);
    // 0.5^1 attenuation is applied.
    expect(Math.abs(edge.score)).toBeLessThan(0.5);
  });

  it('POINT-IN-TIME: occurrences closing after asOf cannot influence the answer (rules 11/21/22)', async () => {
    const f = features({ token_quality: -0.9, convergence: -0.6, momentum: 0.9 });
    const early = new Date('2026-05-01T00:00:00Z');
    const late = new Date('2026-05-20T00:00:00Z');
    const asOf = new Date('2026-05-10T00:00:00Z');

    // 14 raw at 9 days old decays to ~11.4 effective — clears the bar WITH decay applied,
    // so this asserts the asOf filter rather than accidentally asserting the trust threshold.
    await feed(f, 14, 11, early); // visible at asOf
    await feed(f, 20, 0, late);   // all losses, AFTER asOf — must be invisible

    const at = await historicalEdge(db, 'memecoin', f, asOf);
    expect(at.exactOccurrences).toBe(14);
    expect(at.observedWinRate).toBeCloseTo(11 / 14, 6);
    expect(at.score).toBeGreaterThan(0);

    // Reading later sees the losses and flips the sign — proving the filter, not a cache.
    const after = await historicalEdge(db, 'memecoin', f, new Date('2026-05-21T00:00:00Z'));
    expect(after.exactOccurrences).toBe(34);
    expect(after.score).toBeLessThan(0);
  });

  it('recency decay applies at read time: old occurrences weigh less than fresh ones', async () => {
    const f = features({ smart_money: -0.5, convergence: 0.9, market_regime: -0.9, momentum: -0.5 });
    const old = new Date('2026-01-01T00:00:00Z');
    await feed(f, 12, 12, old);
    const fresh = await historicalEdge(db, 'memecoin', f, old);
    const decayed = await historicalEdge(db, 'memecoin', f, new Date(old.getTime() + 90 * 24 * 3600 * 1000));
    expect(fresh.effectiveN).toBeCloseTo(12, 6);
    expect(decayed.effectiveN).toBeCloseTo(12 * 0.125, 6); // 3 memecoin half-lives
    expect(decayed.evidence).toBe('INSUFFICIENT');          // decayed below the trust bar
  });

  it('the ladder write records the occurrence on every rung including global', async () => {
    const f = features({ smart_money: 0.9, convergence: -0.9, momentum: 0.9, token_quality: -0.9, market_regime: 0.9 });
    const predictionId = randomUUID();
    predictionIds.push(predictionId);
    const rows = await recordSetupOutcome(db, {
      predictionId, domain: 'memecoin', features: f, closedAt: T, won: true, returnPct: 0.5,
    });
    for (const r of ladder('memecoin', f)) touched.add(r.setupId);
    expect(rows).toHaveLength(6); // 5 dims + global
    expect(rows.every((r) => r.occurrenceCount >= 1)).toBe(true);
  });

  it('the ladder write is idempotent — replaying a prediction does not double-count any rung', async () => {
    const f = features({ smart_money: -0.9, convergence: 0.9, momentum: -0.9, token_quality: 0.9, market_regime: -0.9 });
    const predictionId = randomUUID();
    predictionIds.push(predictionId);
    const payload = { predictionId, domain: 'memecoin' as const, features: f, closedAt: T, won: true, returnPct: 0.5 };
    const first = await recordSetupOutcome(db, payload);
    const replay = await recordSetupOutcome(db, payload);
    for (const r of ladder('memecoin', f)) touched.add(r.setupId);
    expect(replay.map((r) => r.occurrenceCount)).toEqual(first.map((r) => r.occurrenceCount));
  });
});
