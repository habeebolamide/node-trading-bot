import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { inArray } from 'drizzle-orm';
import { createDb, closeDb, brainSetupMemory, brainSetupOccurrence, type Db } from '@tip/database';
import {
  updateSetupMemory, readSetupMemory, HALFLIFE_DAYS, TRUST_THRESHOLD_EFFECTIVE_N,
  type TradeOutcome,
} from './setup-memory.js';

const DATABASE_URL = process.env.DATABASE_URL;
const DAY_MS = 24 * 60 * 60 * 1000;

describe.skipIf(!DATABASE_URL)('updateSetupMemory (§41, integration)', () => {
  let db: Db;
  const setupIds: string[] = [];

  /** A fresh fingerprint per test so cases can't contaminate each other in a shared DB. */
  function newSetup(): string {
    const id = `test-${randomUUID().replace(/-/g, '')}`.slice(0, 32);
    setupIds.push(id);
    return id;
  }

  function outcome(setupId: string, over: Partial<TradeOutcome> = {}): TradeOutcome {
    return {
      predictionId: randomUUID(),
      setupId,
      domain: 'memecoin',
      closedAt: new Date('2026-06-01T00:00:00Z'),
      won: true,
      returnPct: 0.1,
      ...over,
    };
  }

  /** Feed `n` outcomes all closing at the same instant (weight 1 each). */
  async function feed(setupId: string, n: number, wins: number, closedAt: Date, domain: 'perp' | 'memecoin' = 'memecoin') {
    let last;
    for (let i = 0; i < n; i++) {
      last = await updateSetupMemory(db, outcome(setupId, {
        domain, closedAt, won: i < wins, returnPct: i < wins ? 0.2 : -0.1,
      }));
    }
    return last!;
  }

  beforeAll(() => { db = createDb(DATABASE_URL!); });
  afterAll(async () => {
    if (db) {
      if (setupIds.length) {
        await db.delete(brainSetupOccurrence).where(inArray(brainSetupOccurrence.setupId, setupIds));
        await db.delete(brainSetupMemory).where(inArray(brainSetupMemory.setupId, setupIds));
      }
      await closeDb(db);
    }
  });

  it('first close on an unseen fingerprint creates the row (not an error)', async () => {
    const s = newSetup();
    const row = await updateSetupMemory(db, outcome(s));
    expect(row.occurrenceCount).toBe(1);
    expect(row.effectiveN).toBeCloseTo(1, 10);
    expect(row.effectiveWins).toBeCloseTo(1, 10);
    expect(row.winRate).toBe(1);
    expect(row.evidence).toBe('INSUFFICIENT'); // n=1 < 10
    expect(row.wilsonLower).toBeNull();
    expect(row.wilsonUpper).toBeNull();
  });

  it('stores the point estimate while INSUFFICIENT but withholds Wilson bounds', async () => {
    const s = newSetup();
    const row = await feed(s, 4, 3, new Date('2026-06-01T00:00:00Z'));
    expect(row.winRate).toBeCloseTo(0.75, 10);
    expect(row.evidence).toBe('INSUFFICIENT');
    expect(row.wilsonLower).toBeNull();
  });

  it('flips to SUFFICIENT and gains Wilson bounds at exactly effective-n 10', async () => {
    const s = newSetup();
    const t = new Date('2026-06-01T00:00:00Z');
    const nine = await feed(s, TRUST_THRESHOLD_EFFECTIVE_N - 1, 6, t);
    expect(nine.effectiveN).toBeCloseTo(9, 10);
    expect(nine.evidence).toBe('INSUFFICIENT');
    expect(nine.wilsonLower).toBeNull();

    const ten = await updateSetupMemory(db, outcome(s, { closedAt: t, won: true, returnPct: 0.2 }));
    expect(ten.effectiveN).toBeCloseTo(10, 10);
    expect(ten.evidence).toBe('SUFFICIENT');
    expect(ten.wilsonLower).not.toBeNull();
    expect(ten.wilsonUpper).not.toBeNull();
    expect(ten.wilsonLower!).toBeLessThan(ten.winRate!);
    expect(ten.wilsonUpper!).toBeGreaterThan(ten.winRate!);
  });

  it('decays across a half-life boundary: an occurrence 30d old contributes exactly 0.5 (memecoin)', async () => {
    const s = newSetup();
    const old = new Date('2026-05-02T00:00:00Z');
    const now = new Date(old.getTime() + HALFLIFE_DAYS.memecoin * DAY_MS);
    await updateSetupMemory(db, outcome(s, { closedAt: old, won: true }));
    const row = await updateSetupMemory(db, outcome(s, { closedAt: now, won: true }));
    // fresh (weight 1) + one half-life old (weight 0.5)
    expect(row.effectiveN).toBeCloseTo(1.5, 10);
    expect(row.effectiveWins).toBeCloseTo(1.5, 10);
  });

  it('uses the domain half-life: the same age decays less for perp (90d) than memecoin (30d)', async () => {
    const old = new Date('2026-03-03T00:00:00Z');
    const now = new Date(old.getTime() + 90 * DAY_MS);

    const perpSetup = newSetup();
    await updateSetupMemory(db, outcome(perpSetup, { domain: 'perp', closedAt: old }));
    const perp = await updateSetupMemory(db, outcome(perpSetup, { domain: 'perp', closedAt: now }));

    const memeSetup = newSetup();
    await updateSetupMemory(db, outcome(memeSetup, { closedAt: old }));
    const meme = await updateSetupMemory(db, outcome(memeSetup, { closedAt: now }));

    expect(perp.effectiveN).toBeCloseTo(1.5, 10); // 90d = one perp half-life
    expect(meme.effectiveN).toBeCloseTo(1.125, 10); // 90d = three memecoin half-lives → 0.125
    expect(perp.effectiveN).toBeGreaterThan(meme.effectiveN);
  });

  it('recency-weighted result equals the unweighted one when all occurrences are simultaneous', async () => {
    const s = newSetup();
    const t = new Date('2026-06-01T00:00:00Z');
    const row = await feed(s, 8, 5, t);
    // All weights are exactly 1, so effective values collapse to raw counts.
    expect(row.effectiveN).toBeCloseTo(8, 10);
    expect(row.effectiveWins).toBeCloseTo(5, 10);
    expect(row.winRate).toBeCloseTo(5 / 8, 10);
    expect(row.occurrenceCount).toBe(8);
  });

  it('is idempotent — replaying the same prediction is a DB-level no-op (rule 12)', async () => {
    const s = newSetup();
    const o = outcome(s, { won: true, returnPct: 0.3 });
    const first = await updateSetupMemory(db, o);
    const replay = await updateSetupMemory(db, o);
    expect(replay.occurrenceCount).toBe(first.occurrenceCount);
    expect(replay.effectiveN).toBeCloseTo(first.effectiveN, 10);
    expect(replay.effectiveWins).toBeCloseTo(first.effectiveWins, 10);
  });

  it('chronological replay is reproducible — the same fixture twice yields identical rows (rule 11)', async () => {
    // This is the invariant the backtest actually depends on: "same historical fixture in twice,
    // byte-identical Setup Memory rows out" (CLAUDE.md integration-test list).
    const t0 = new Date('2026-04-01T00:00:00Z');
    const times = [0, 10, 20].map((d) => new Date(t0.getTime() + d * DAY_MS));

    const runA = newSetup();
    for (const t of times) await updateSetupMemory(db, outcome(runA, { closedAt: t, won: true }));
    const a = await readSetupMemory(db, runA);

    const runB = newSetup();
    for (const t of times) await updateSetupMemory(db, outcome(runB, { closedAt: t, won: true }));
    const b = await readSetupMemory(db, runB);

    expect(b!.effectiveN).toBeCloseTo(a!.effectiveN, 12);
    expect(b!.effectiveWins).toBeCloseTo(a!.effectiveWins, 12);
    expect(b!.winRate).toBeCloseTo(a!.winRate!, 12);
    expect(b!.medianReturn).toBeCloseTo(a!.medianReturn!, 12);
    // 1 (fresh) + 0.5^(10/30) + 0.5^(20/30)
    expect(a!.effectiveN).toBeCloseTo(1 + 0.5 ** (10 / 30) + 0.5 ** (20 / 30), 10);
  });

  it('out-of-order arrival writes an as-of-that-outcome row, then converges on the next chronological write', async () => {
    // §41 fixes `now = outcome.closedAt`, and this implementation additionally filters
    // occurrences to `closedAt <= now`. Together that means a late-arriving OLD outcome writes
    // the row as of its own close time — a stale but deterministic snapshot — rather than
    // assigning the newer occurrences a negative age (weight > 1), which is what an unfiltered
    // read would do. The next chronological write restores the full picture.
    const s = newSetup();
    const t0 = new Date('2026-04-01T00:00:00Z');
    const t1 = new Date(t0.getTime() + 20 * DAY_MS);

    await updateSetupMemory(db, outcome(s, { closedAt: t1, won: true }));
    const backfilled = await updateSetupMemory(db, outcome(s, { closedAt: t0, won: true }));
    expect(backfilled.occurrenceCount).toBe(1); // only the t0 occurrence is <= t0
    expect(backfilled.effectiveN).toBeCloseTo(1, 10);

    const caughtUp = await updateSetupMemory(db, outcome(s, { closedAt: t1, won: true }));
    expect(caughtUp.occurrenceCount).toBe(3);
    expect(caughtUp.effectiveN).toBeGreaterThan(2);
    // No weight can exceed 1 — nothing was dated into the future.
    expect(caughtUp.effectiveN).toBeLessThanOrEqual(caughtUp.occurrenceCount);
  });

  it('medianReturn is the weighted median of the occurrence returns', async () => {
    const s = newSetup();
    const t = new Date('2026-06-01T00:00:00Z');
    await updateSetupMemory(db, outcome(s, { closedAt: t, won: false, returnPct: -0.5 }));
    await updateSetupMemory(db, outcome(s, { closedAt: t, won: true, returnPct: 0.1 }));
    const row = await updateSetupMemory(db, outcome(s, { closedAt: t, won: true, returnPct: 0.9 }));
    expect(row.medianReturn).toBeCloseTo(0.1, 10);
  });

  it('readSetupMemory returns null for a never-written fingerprint and round-trips a written one', async () => {
    expect(await readSetupMemory(db, 'nonexistent-fingerprint-000000000')).toBeNull();
    const s = newSetup();
    const written = await updateSetupMemory(db, outcome(s));
    const read = await readSetupMemory(db, s);
    expect(read!.effectiveN).toBeCloseTo(written.effectiveN, 10);
    expect(read!.evidence).toBe(written.evidence);
    expect(read!.domain).toBe('memecoin');
  });

  it('write path never backs off — an INSUFFICIENT cell keeps its own thin numbers (§41)', async () => {
    const s = newSetup();
    const row = await feed(s, 3, 3, new Date('2026-06-01T00:00:00Z'));
    expect(row.evidence).toBe('INSUFFICIENT');
    expect(row.winRate).toBe(1); // its OWN 3/3, not a parent bucket's rate
    expect(row.wilsonLower).toBeNull();
  });
});
