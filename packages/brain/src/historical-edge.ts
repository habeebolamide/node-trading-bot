/**
 * Historical Edge read path (§40.16 perp / §40.19 memecoin, Part II §8).
 *
 * Walks the backoff ladder and returns §8's EXPLICIT-STATE object — never a thin cell's win rate
 * dressed up as confident. §8's worked example is the spec: 7 exact occurrences at 86% must
 * surface as `INSUFFICIENT` with the parent bucket's rate, not as `86%`.
 *
 * POINT-IN-TIME (rules 11/21/22). `asOf` is REQUIRED and the aggregates are recomputed from the
 * occurrence log filtered to `closed_at <= asOf` — deliberately NOT read from the materialized
 * `brain_setup_memory` row, which reflects whenever it was last written and would leak future
 * outcomes into a historical read. There is no `currentHistoricalEdge()` / `latest()` variant
 * for backtest code to reach for by mistake; leaking future outcomes into a historical
 * fingerprint is the single most damaging look-ahead bug available here, because it would make
 * the backtest look brilliant for exactly the wrong reason.
 */
import { and, inArray, lte } from 'drizzle-orm';
import { brainSetupOccurrence, type Db } from '@tip/database';
import { ladder, type Rung } from './backoff.js';
import type { Domain, FeatureTuple } from './fingerprint.js';
import { HALFLIFE_DAYS, TRUST_THRESHOLD_EFFECTIVE_N, type Evidence } from './setup-memory.js';
import { recencyWeight, weightedMedian, wilsonInterval, type WeightedItem } from './stats.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

export interface HistoricalEdge {
  /** SUFFICIENT only when RUNG 0 — the exact fingerprint — cleared the trust bar (§8). */
  readonly evidence: Evidence;
  /** Raw occurrence count at the exact fingerprint, for §8's explicit-state object. */
  readonly exactOccurrences: number;
  /** Rung-0 point estimate. Reported for transparency; never used as the score when INSUFFICIENT. */
  readonly observedWinRate: number | null;
  /** Description of the rung that actually answered, or null when rung 0 did. */
  readonly fallback: string | null;
  readonly fallbackWinRate: number | null;
  /** 0 = exact; equals the ladder length when nothing cleared. */
  readonly backoffDepth: number;
  readonly effectiveN: number;
  readonly ciWidth: number | null;
  readonly medianReturn: number | null;
  /** Signed [-1,+1] contribution to the composite. */
  readonly score: number;
  /** Task-6 `historicalEvidence` confidence sub-metric, [0,1]. */
  readonly historicalEvidence: number;
}

interface RungStats {
  effectiveN: number;
  effectiveWins: number;
  winRate: number | null;
  medianReturn: number | null;
  occurrenceCount: number;
}

const EMPTY: RungStats = { effectiveN: 0, effectiveWins: 0, winRate: null, medianReturn: null, occurrenceCount: 0 };

/**
 * Task 6's `historicalEvidence = f(effective-n, Wilson width)`, low when INSUFFICIENT.
 *
 * The INSUFFICIENT floor is 0.25, not 0: driving a 25%-weighted sub-metric to zero would cap
 * total confidence near 0.75 for every signal until the Brain warms up, which would make M6's
 * early calibration curves unreadable. "We looked and found nothing" is weak evidence, not a
 * confidence-destroying fault.
 */
export const INSUFFICIENT_EVIDENCE_FLOOR = 0.25;

export function historicalEvidenceFrom(effectiveN: number, ciWidth: number | null): number {
  if (ciWidth === null) return INSUFFICIENT_EVIDENCE_FLOOR;
  const sampleTerm = Math.min(1, effectiveN / (TRUST_THRESHOLD_EFFECTIVE_N * 3)); // saturates at 3× the trust floor
  const precisionTerm = clamp01(1 - ciWidth);
  return clamp01(sampleTerm * precisionTerm);
}

/**
 * §40.16 step 4. Sign from `sign(winRate − 0.5)`; magnitude scaled by Wilson CI width (narrow =
 * strong); attenuated by 0.5^depth so "every layer of backoff reduces confidence attributed to
 * this feature — a global-base-rate fallback contributes near-zero."
 *
 * SIGN CONVENTION — the plan is explicit and the opposite reading is a plausible mistake that
 * would silently invert 5% of both composites: a win rate above 50% AMPLIFIES the trade's
 * direction rather than countering it. Setup Memory records the outcome of predictions made in
 * whatever direction the composite chose, so >50% means "setups shaped like this one have been
 * paying off" — a directionless quality multiplier, not a directional opinion.
 */
export function edgeScore(winRate: number, ciWidth: number, backoffDepth: number): number {
  const magnitude = Math.min(1, Math.abs(winRate - 0.5) * 2);
  const strength = clamp01(1 - ciWidth);
  const attenuation = Math.pow(0.5, backoffDepth);
  return Math.sign(winRate - 0.5) * magnitude * strength * attenuation;
}

/** Recency-weighted aggregate over one rung's occurrences, as of `asOf`. */
function aggregate(
  rows: readonly { closedAt: Date; won: boolean; returnPct: string }[],
  asOf: Date,
  halflifeDays: number,
): RungStats {
  let effectiveN = 0;
  let effectiveWins = 0;
  const returns: WeightedItem[] = [];
  for (const r of rows) {
    const weight = recencyWeight((asOf.getTime() - r.closedAt.getTime()) / DAY_MS, halflifeDays);
    effectiveN += weight;
    if (r.won) effectiveWins += weight;
    returns.push({ value: Number(r.returnPct), weight });
  }
  return {
    effectiveN,
    effectiveWins,
    winRate: effectiveN > 0 ? effectiveWins / effectiveN : null,
    medianReturn: weightedMedian(returns),
    occurrenceCount: rows.length,
  };
}

export async function historicalEdge(
  db: Db,
  domain: Domain,
  features: FeatureTuple,
  asOf: Date,
): Promise<HistoricalEdge> {
  const rungs = ladder(domain, features);
  const halflifeDays = HALFLIFE_DAYS[domain];

  // One round trip for the whole ladder, then group in memory — 6–9 keyed reads would be
  // wasteful and the occurrence rows are narrow.
  const rows = await db
    .select({
      setupId: brainSetupOccurrence.setupId,
      closedAt: brainSetupOccurrence.closedAt,
      won: brainSetupOccurrence.won,
      returnPct: brainSetupOccurrence.returnPct,
    })
    .from(brainSetupOccurrence)
    .where(and(
      inArray(brainSetupOccurrence.setupId, rungs.map((r) => r.setupId)),
      lte(brainSetupOccurrence.closedAt, asOf),
    ));

  const bySetup = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = bySetup.get(r.setupId);
    if (list) list.push(r);
    else bySetup.set(r.setupId, [r]);
  }

  const statsFor = (rung: Rung): RungStats => {
    const list = bySetup.get(rung.setupId);
    return list ? aggregate(list, asOf, halflifeDays) : EMPTY;
  };

  const exact = statsFor(rungs[0]!);

  // Walk down until a rung clears the trust bar.
  let answering: { rung: Rung; stats: RungStats } | null = null;
  for (const rung of rungs) {
    const stats = statsFor(rung);
    if (stats.effectiveN >= TRUST_THRESHOLD_EFFECTIVE_N) {
      answering = { rung, stats };
      break;
    }
  }

  // Nothing anywhere on the ladder has enough evidence — the honest answer is "no opinion".
  // This is the correct state for an empty Brain (i.e. everything before M6 resolves outcomes),
  // and it contributes exactly 0 to the composite rather than noise.
  if (!answering) {
    return {
      evidence: 'INSUFFICIENT',
      exactOccurrences: exact.occurrenceCount,
      observedWinRate: exact.winRate,
      fallback: null,
      fallbackWinRate: null,
      backoffDepth: rungs.length,
      effectiveN: exact.effectiveN,
      ciWidth: null,
      medianReturn: exact.medianReturn,
      score: 0,
      historicalEvidence: INSUFFICIENT_EVIDENCE_FLOOR,
    };
  }

  const { rung, stats } = answering;
  const ci = wilsonInterval(stats.effectiveWins, stats.effectiveN, 0.95);
  const ciWidth = ci.upper - ci.lower;
  const answeredExactly = rung.depth === 0;

  return {
    // §8's explicit-state semantics: SUFFICIENT means the EXACT fingerprint cleared the bar.
    // A signal answered from a coarser rung is INSUFFICIENT with the fallback populated.
    evidence: answeredExactly ? 'SUFFICIENT' : 'INSUFFICIENT',
    exactOccurrences: exact.occurrenceCount,
    observedWinRate: exact.winRate,
    fallback: answeredExactly ? null : rung.label,
    fallbackWinRate: answeredExactly ? null : stats.winRate,
    backoffDepth: rung.depth,
    effectiveN: stats.effectiveN,
    ciWidth,
    medianReturn: stats.medianReturn,
    score: edgeScore(stats.winRate!, ciWidth, rung.depth),
    historicalEvidence: historicalEvidenceFrom(stats.effectiveN, ciWidth),
  };
}
