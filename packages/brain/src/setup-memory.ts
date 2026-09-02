/**
 * BrainSetupMemory write path — §41 Reference Function, followed exactly.
 *
 * Called on every closed prediction, from the outcome-resolution event handler in the paper
 * engine. THAT CALL SITE IS M6 — this module delivers the tested function; M6 wires it, per the
 * §30 build order. Until then the table stays legitimately empty and every read returns
 * INSUFFICIENT, which is correct behaviour and asserted by the tests.
 *
 * Both domains call this same function, differing only via the half-life lookup. Do not fork it
 * per domain: §41's implementer note is explicit that a bug in one is a bug in both, which is
 * easier to catch than two subtly different bugs.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, lte } from 'drizzle-orm';
import { brainSetupMemory, brainSetupOccurrence, type Db } from '@tip/database';
import { ValidationError } from '@tip/domain';
import type { Domain, FeatureTuple } from './fingerprint.js';
import { ladder } from './backoff.js';
import { recencyWeight, weightedMedian, wilsonInterval, type WeightedItem } from './stats.js';

/** Half-lives per Task 6's resolution. Perp setups decay slower — it is seeded and higher-volume. */
export const HALFLIFE_DAYS: Record<Domain, number> = {
  perp: 90, // Task 6 resolution
  memecoin: 30, // Task 6 resolution
};

/**
 * Setup Memory's own trust bar (§8/§25, lowered from 20).
 *
 * Hypothesis eligibility (§24) uses a SEPARATE effective-n ≥ 20 check at a different call site.
 * Do not conflate them — §41's implementer note calls this out by name, and the split rationale
 * lives in §24.
 */
export const TRUST_THRESHOLD_EFFECTIVE_N = 10;

export type Evidence = 'SUFFICIENT' | 'INSUFFICIENT';

export interface TradeOutcome {
  readonly predictionId: string;
  readonly setupId: string;
  readonly domain: Domain;
  readonly closedAt: Date;
  readonly won: boolean;
  readonly returnPct: number;
  // outcomeResolution (TICK | CANDLE_1M_CONSERVATIVE) lives on PredictionOutcome separately —
  // not needed here (§41).
}

export interface SetupMemoryRow {
  readonly setupId: string;
  readonly domain: Domain;
  readonly effectiveN: number;
  readonly effectiveWins: number;
  readonly winRate: number | null;
  readonly medianReturn: number | null;
  readonly wilsonLower: number | null;
  readonly wilsonUpper: number | null;
  readonly evidence: Evidence;
  readonly occurrenceCount: number;
  readonly lastUpdatedAt: Date;
}

/**
 * Record one closed prediction against one fingerprint and recompute that cell's live estimate.
 *
 * Idempotent by DB constraint (rule 12): the occurrence insert is `onConflictDoNothing` against
 * `unique(prediction_id, setup_id)`, so a redelivered outcome event cannot double-count. This is
 * a DB-level guarantee, never an application-side check-then-write (§29).
 */
export async function updateSetupMemory(db: Db, outcome: TradeOutcome): Promise<SetupMemoryRow> {
  const halflifeDays = HALFLIFE_DAYS[outcome.domain];
  if (halflifeDays === undefined) {
    throw new ValidationError(`Unknown domain "${outcome.domain}"`);
  }

  // Append the occurrence. History is never deleted; only its influence on the current live
  // estimate decays via the weights below (Part II §8).
  await db
    .insert(brainSetupOccurrence)
    .values({
      id: randomUUID(),
      setupId: outcome.setupId,
      predictionId: outcome.predictionId,
      domain: outcome.domain,
      closedAt: outcome.closedAt,
      won: outcome.won,
      returnPct: String(outcome.returnPct),
    })
    .onConflictDoNothing();

  // "As of the newest outcome" — deterministic (§41). Deliberately NOT Date.now(): a backtest
  // replaying the same fixture twice must produce byte-identical rows (rules 11/21/22), which
  // wall-clock decay would break.
  const now = outcome.closedAt;

  // Recompute recency-weighted aggregates across ALL occurrences of this fingerprint that had
  // closed by `now`.
  //
  // The `<= now` filter is an ADDITION over §41's reference code, which iterates every
  // occurrence unconditionally. §41 assumes chronological arrival (true in production: the
  // paper engine resolves as positions close, and a backtest replays in order), and under that
  // assumption the two are identical. They differ only when an OLD outcome arrives late, where
  // unfiltered iteration would hand the newer occurrences a negative age and therefore a weight
  // > 1 — silently inflating effectiveN. Filtering instead writes a stale-but-correct snapshot
  // as of this outcome's close, which the next chronological write supersedes. Covered by the
  // "out-of-order arrival" integration test.
  const occurrences = await db
    .select({
      closedAt: brainSetupOccurrence.closedAt,
      won: brainSetupOccurrence.won,
      returnPct: brainSetupOccurrence.returnPct,
    })
    .from(brainSetupOccurrence)
    .where(and(eq(brainSetupOccurrence.setupId, outcome.setupId), lte(brainSetupOccurrence.closedAt, now)));

  let effectiveN = 0;
  let effectiveWins = 0;
  const weightedReturns: WeightedItem[] = [];

  for (const occ of occurrences) {
    const ageDays = (now.getTime() - occ.closedAt.getTime()) / (1000 * 60 * 60 * 24);
    const weight = recencyWeight(ageDays, halflifeDays);

    effectiveN += weight;
    if (occ.won) effectiveWins += weight;
    weightedReturns.push({ value: Number(occ.returnPct), weight });
  }

  const winRate = effectiveN > 0 ? effectiveWins / effectiveN : null;
  const medianReturn = weightedMedian(weightedReturns);

  // Wilson CI on effective-n, not raw count (Part II §8 correction).
  let wilsonLower: number | null = null;
  let wilsonUpper: number | null = null;
  let evidence: Evidence = 'INSUFFICIENT';
  if (effectiveN >= TRUST_THRESHOLD_EFFECTIVE_N) {
    const ci = wilsonInterval(effectiveWins, effectiveN, 0.95);
    wilsonLower = ci.lower;
    wilsonUpper = ci.upper;
    evidence = 'SUFFICIENT';
  }
  // Below the threshold the point estimate is still stored (winRate above) but flagged
  // INSUFFICIENT with null bounds. Parent-bucket fallback happens at READ time — see the
  // Historical Edge feature (§40.16 / §40.19). This function never dips into the parent bucket,
  // never recurses, and never writes fallback stats here: keeping the split write-side/read-side
  // is what makes cached reads consistent and future backtest replays reproducible (§41).

  const row = {
    setupId: outcome.setupId,
    domain: outcome.domain,
    effectiveN: String(effectiveN),
    effectiveWins: String(effectiveWins),
    winRate: winRate === null ? null : String(winRate),
    medianReturn: medianReturn === null ? null : String(medianReturn),
    wilsonLower: wilsonLower === null ? null : String(wilsonLower),
    wilsonUpper: wilsonUpper === null ? null : String(wilsonUpper),
    evidence,
    occurrenceCount: occurrences.length,
    lastUpdatedAt: now,
  };

  await db
    .insert(brainSetupMemory)
    .values(row)
    .onConflictDoUpdate({ target: brainSetupMemory.setupId, set: row });

  return {
    setupId: outcome.setupId,
    domain: outcome.domain,
    effectiveN,
    effectiveWins,
    winRate,
    medianReturn,
    wilsonLower,
    wilsonUpper,
    evidence,
    occurrenceCount: occurrences.length,
    lastUpdatedAt: now,
  };
}

/**
 * Exact-fingerprint read. NO hierarchical backoff — that is m5-historical-edge's job, and the
 * split is deliberate (§41). Returns null when the cell has never been written.
 */
export async function readSetupMemory(db: Db, setupId: string): Promise<SetupMemoryRow | null> {
  const rows = await db.select().from(brainSetupMemory).where(eq(brainSetupMemory.setupId, setupId)).limit(1);
  const r = rows[0];
  if (!r) return null;
  return {
    setupId: r.setupId,
    domain: r.domain as Domain,
    effectiveN: Number(r.effectiveN),
    effectiveWins: Number(r.effectiveWins),
    winRate: r.winRate === null ? null : Number(r.winRate),
    medianReturn: r.medianReturn === null ? null : Number(r.medianReturn),
    wilsonLower: r.wilsonLower === null ? null : Number(r.wilsonLower),
    wilsonUpper: r.wilsonUpper === null ? null : Number(r.wilsonUpper),
    evidence: r.evidence as Evidence,
    occurrenceCount: r.occurrenceCount,
    lastUpdatedAt: r.lastUpdatedAt,
  };
}

/**
 * Ladder-aware write (m5-historical-edge). Records ONE closed prediction against every rung of
 * the backoff ladder — the exact fingerprint, each coarser rung, and the domain's global base
 * rate — so a read is a keyed lookup per rung instead of an on-demand aggregation.
 *
 * This is the call site M6's outcome-resolution handler uses (not `updateSetupMemory` directly,
 * which stays the single-cell §41 primitive).
 *
 * Why materialize rather than aggregate on read: an on-demand `GROUP BY` over the occurrence
 * history would re-read everything per signal AND would make a read's answer depend on when it
 * ran, which breaks replay reproducibility (rule 11). Materializing keeps every rung a plain
 * keyed row computed by the same §41 math.
 *
 * Cost is 6 rows per occurrence (memecoin) / 9 (perp) instead of 1 — negligible at one memecoin
 * position at a time (§32) and perp's paper volume. Idempotency still holds: the occurrence
 * unique key is `(prediction_id, setup_id)`, and each rung has a distinct setup_id.
 */
export async function recordSetupOutcome(
  db: Db,
  outcome: Omit<TradeOutcome, 'setupId'> & { features: FeatureTuple },
): Promise<SetupMemoryRow[]> {
  const rungs = ladder(outcome.domain, outcome.features);
  const rows: SetupMemoryRow[] = [];
  for (const rung of rungs) {
    rows.push(await updateSetupMemory(db, {
      predictionId: outcome.predictionId,
      setupId: rung.setupId,
      domain: outcome.domain,
      closedAt: outcome.closedAt,
      won: outcome.won,
      returnPct: outcome.returnPct,
    }));
  }
  return rows;
}
