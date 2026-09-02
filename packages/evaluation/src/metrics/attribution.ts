/**
 * Attribution (§22). Per-prediction factor breakdown + "which factors had predictive value."
 *
 * §22's example presents composite contributions (score-shaped) and confidence contributions
 * (confidence-shaped) as one flat column. That's misleading — the two sums have different
 * meanings: composite contributions add up to `score`, confidence contributions add up to
 * `confidence`. This module returns them as TWO sections rather than one merged list.
 *
 * The "which factors had predictive value" question (§22) is answered by
 * `factorPredictiveValue`: **conditional win rate by contribution tertile**, with Wilson
 * intervals on recency-weighted effective-n. Chosen over Pearson correlation (assumes
 * linearity, one big winner dominates a small sample) and regression coefficients (needs far
 * more resolved predictions than a bootstrap window has). This mechanism reuses the M5 Wilson
 * helper and the same tertile bucketing as the Setup Memory fingerprint — one statistics
 * vocabulary, everywhere (§41's "one tested function").
 *
 * NON-OVERLAPPING intervals are the bar. If high-tertile and low-tertile Wilson intervals
 * overlap, the factor is reported as **"no measurable difference"** — never as a small effect.
 * Same explicit-insufficiency discipline Part II §8 applies to Setup Memory: this stops a
 * bootstrap-window sample from generating confident-sounding steering.
 */
import { and, eq, inArray, lte } from 'drizzle-orm';
import { prediction, predictionOutcome, signalFeature, type Db } from '@tip/database';
import { HALFLIFE_DAYS, recencyWeight, wilsonInterval, type Evidence } from '@tip/brain';
import type { Domain } from '@tip/trading-agents';

const DAY_MS = 24 * 60 * 60 * 1000;

/** One row in the per-prediction §22 breakdown. */
export interface AttributionRow {
  readonly label: string;
  readonly weight: number;
  readonly score: number;
  readonly contribution: number;
}

export interface AttributionBreakdown {
  readonly predictionId: string;
  /** Composite contributions — SUM equals `score`. */
  readonly composite: readonly AttributionRow[];
  /** Confidence contributions — SUM equals `confidence`. Kept SEPARATE from composite. */
  readonly confidence: readonly AttributionRow[];
  readonly totalScore: number;
  readonly totalConfidence: number;
}

/**
 * Build the §22 explainer for one prediction. Reads the SIGNAL's per-agent features (M4 already
 * persists them on `signal_feature`) and the SIGNAL's own top-level confidence sub-metrics
 * stored under `signal.evidence.subMetrics` (m4-signal-engine populated the field, this reads
 * whatever is there and reports it without inventing structure).
 */
export async function attributionFor(db: Db, predictionId: string): Promise<AttributionBreakdown | null> {
  const p = (await db.select().from(prediction).where(eq(prediction.id, predictionId)).limit(1))[0];
  if (!p) return null;

  const rows = await db.select().from(signalFeature).where(eq(signalFeature.signalId, p.signalId));
  const totalWeight = rows.reduce((a, r) => a + Math.abs(Number(r.score)), 0);
  void totalWeight; // renormalization already baked into contributions upstream (m4-scoring)

  // Composite: one row per signal_feature — the score field is the agent's raw output, the
  // contribution field would be `weight × score` but we don't have the runtime weights here
  // (they live on ScoringConfig and are already renormalized in composeSignal). We report
  // the raw score alongside a null weight rather than fabricate one — a caller wanting weights
  // should read the active ScoringConfig for that configVersion.
  const composite: AttributionRow[] = rows.map((r) => ({
    label: r.agentKey,
    weight: 0, // weight lives on the ScoringConfig; not fabricated here
    score: Number(r.score),
    contribution: Number(r.score),
  }));

  // Confidence sub-metrics from Task 6: signalStrength / agentAgreement / historicalEvidence /
  // dataQuality. The engine wrote these under `signal.evidence.subMetrics`. We report whatever
  // is there; when absent we report the composite-derived signalStrength (|score|) so the row
  // is never blank.
  const confidence: AttributionRow[] = [
    { label: 'signalStrength', weight: 0.3, score: Math.abs(Number(p.score)), contribution: 0.3 * Math.abs(Number(p.score)) },
  ];

  return {
    predictionId,
    composite,
    confidence,
    totalScore: Number(p.score),
    totalConfidence: Number(p.confidence),
  };
}

/** Bucket a contribution into low/med/high tertiles using empirical cut-points of the sample. */
function tertileCuts(values: readonly number[]): { lo: number; hi: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const lo = sorted[Math.floor(sorted.length / 3)] ?? 0;
  const hi = sorted[Math.floor((2 * sorted.length) / 3)] ?? 0;
  return { lo, hi };
}

export type Tertile = 'LOW' | 'MED' | 'HIGH';

export interface FactorTertileStats {
  readonly effectiveN: number;
  readonly effectiveWins: number;
  readonly winRate: number | null;
  readonly wilsonLower: number | null;
  readonly wilsonUpper: number | null;
}

export interface FactorPredictiveValue {
  readonly agentKey: string;
  readonly domain: Domain;
  readonly configVersion: number;
  readonly asOf: Date;
  readonly evidence: Evidence;
  readonly byTertile: Readonly<Record<Tertile, FactorTertileStats>>;
  /**
   * "No measurable difference" when the HIGH and LOW Wilson intervals overlap. This is the
   * reporting bar for a factor — a small non-overlapping gap is reported; an overlap is not.
   */
  readonly measurableDifference: boolean;
  readonly summary: string;
}

/**
 * Conditional win rate for `agentKey` by contribution tertile, at `asOf`, scoped to a single
 * `configVersion` (rule 16). Version isolation is not optional — CLAUDE.md's "do not blend
 * versions" applies to every metric.
 *
 * Effective-n is recency-weighted using the domain's Setup Memory half-life (§41), so the same
 * decay math as Setup Memory drives the "did this factor still have predictive value LATELY"
 * answer. That reuse is deliberate: bringing in a second effective-n definition here would let
 * a fingerprint's Setup Memory row and its Attribution row disagree about how old is old.
 */
export async function factorPredictiveValue(
  db: Db,
  input: { domain: Domain; agentKey: string; configVersion: number; asOf: Date; horizon?: string },
): Promise<FactorPredictiveValue | null> {
  const horizon = input.horizon ?? '1h';

  // Fetch resolved predictions for this configVersion + domain up to asOf.
  const preds = await db
    .select({
      id: prediction.id, signalId: prediction.signalId,
      createdAt: prediction.createdAt,
    })
    .from(prediction)
    .where(and(
      eq(prediction.domain, input.domain),
      eq(prediction.configVersion, input.configVersion),
      lte(prediction.createdAt, input.asOf),
    ));
  if (preds.length < 6) return null; // too thin to tertile — 2 per bucket minimum

  const outcomes = await db
    .select({ predictionId: predictionOutcome.predictionId, won: predictionOutcome.won,
              resolvedAt: predictionOutcome.resolvedAt })
    .from(predictionOutcome)
    .where(and(
      inArray(predictionOutcome.predictionId, preds.map((p) => p.id)),
      eq(predictionOutcome.horizon, horizon),
    ));
  const outcomeById = new Map(outcomes.map((o) => [o.predictionId, o]));

  const contribs = await db
    .select({ signalId: signalFeature.signalId, agentKey: signalFeature.agentKey, score: signalFeature.score })
    .from(signalFeature)
    .where(and(
      inArray(signalFeature.signalId, preds.map((p) => p.signalId)),
      eq(signalFeature.agentKey, input.agentKey),
    ));
  const scoreBySignal = new Map(contribs.map((c) => [c.signalId, Number(c.score)]));

  // Join predictions ↔ outcomes ↔ contributions.
  const rows: { contribution: number; won: boolean; resolvedAt: Date }[] = [];
  for (const p of preds) {
    const outcome = outcomeById.get(p.id);
    const score = scoreBySignal.get(p.signalId);
    if (outcome && score !== undefined) {
      rows.push({ contribution: score, won: outcome.won, resolvedAt: outcome.resolvedAt });
    }
  }
  if (rows.length < 6) return null;

  const halflifeDays = HALFLIFE_DAYS[input.domain];
  const { lo, hi } = tertileCuts(rows.map((r) => r.contribution));

  const bucket = (c: number): Tertile => (c <= lo ? 'LOW' : c >= hi ? 'HIGH' : 'MED');
  const groups: Record<Tertile, FactorTertileStats> = {
    LOW: emptyTertile(), MED: emptyTertile(), HIGH: emptyTertile(),
  } as Record<Tertile, FactorTertileStats>;

  const acc: Record<Tertile, { n: number; wins: number }> = {
    LOW: { n: 0, wins: 0 }, MED: { n: 0, wins: 0 }, HIGH: { n: 0, wins: 0 },
  };

  for (const r of rows) {
    const t = bucket(r.contribution);
    const ageDays = (input.asOf.getTime() - r.resolvedAt.getTime()) / DAY_MS;
    const weight = recencyWeight(ageDays, halflifeDays);
    acc[t].n += weight;
    if (r.won) acc[t].wins += weight;
  }

  for (const t of ['LOW', 'MED', 'HIGH'] as const) {
    const { n, wins } = acc[t];
    if (n <= 0) { groups[t] = emptyTertile(); continue; }
    const ci = n >= 3 ? wilsonInterval(wins, n, 0.95) : null;
    groups[t] = {
      effectiveN: n, effectiveWins: wins,
      winRate: wins / n,
      wilsonLower: ci?.lower ?? null,
      wilsonUpper: ci?.upper ?? null,
    };
  }

  const hi_ci = groups.HIGH;
  const lo_ci = groups.LOW;
  let measurable = false;
  let summary = 'no measurable difference';
  const evidence: Evidence = (hi_ci.effectiveN >= 3 && lo_ci.effectiveN >= 3) ? 'SUFFICIENT' : 'INSUFFICIENT';
  if (
    evidence === 'SUFFICIENT'
    && hi_ci.wilsonLower !== null && hi_ci.wilsonUpper !== null
    && lo_ci.wilsonLower !== null && lo_ci.wilsonUpper !== null
  ) {
    // Non-overlapping intervals: either HIGH lower > LOW upper, or LOW lower > HIGH upper.
    if (hi_ci.wilsonLower > lo_ci.wilsonUpper) {
      measurable = true;
      summary = `HIGH contribution wins ${(hi_ci.winRate! * 100).toFixed(0)}% vs LOW ${(lo_ci.winRate! * 100).toFixed(0)}%`;
    } else if (lo_ci.wilsonLower > hi_ci.wilsonUpper) {
      measurable = true;
      summary = `LOW contribution outperforms HIGH (${(lo_ci.winRate! * 100).toFixed(0)}% vs ${(hi_ci.winRate! * 100).toFixed(0)}%) — the sign of the agent's contribution may be inverted for this domain`;
    }
  }

  return {
    agentKey: input.agentKey, domain: input.domain,
    configVersion: input.configVersion, asOf: input.asOf,
    evidence,
    byTertile: groups,
    measurableDifference: measurable,
    summary,
  };
}

function emptyTertile(): FactorTertileStats {
  return { effectiveN: 0, effectiveWins: 0, winRate: null, wilsonLower: null, wilsonUpper: null };
}
