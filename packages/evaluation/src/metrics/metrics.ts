/**
 * §32 success-criteria metric set. Every query groups by `configVersion` and there is NO
 * "all versions" convenience accessor: "silently blending track records across versions
 * destroys the 'did this change actually help' question" (CLAUDE.md).
 *
 * All reads are functions returning plain rows. No HTTP layer, no formatting — M8 adds those.
 * Keeping the boundary at "functions returning rows" means dashboard churn never reaches the
 * statistics.
 */
import { and, asc, avg, count, eq, inArray, lte, sql } from 'drizzle-orm';
import { prediction, predictionOutcome, type Db } from '@tip/database';
import type { Domain } from '@tip/trading-agents';
import { wilsonInterval } from '@tip/brain';

export interface HeadlineMetrics {
  readonly domain: Domain;
  readonly configVersion: number;
  readonly horizon: string;
  readonly n: number;
  readonly wins: number;
  readonly accuracy: number | null;
  readonly wilsonLower: number | null;
  readonly wilsonUpper: number | null;
  readonly medianReturn: number | null;
  readonly meanReturn: number | null;
  readonly meanAlpha: number | null;
  readonly maxDrawdown: number | null;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/**
 * Headline for one (domain, configVersion, horizon). Returns null when nothing has resolved —
 * a caller distinguishes "no data" from "bad calibration"; the API refuses to invent one.
 */
export async function headlineMetrics(
  db: Db,
  input: { domain: Domain; configVersion: number; horizon: string; asOf: Date },
): Promise<HeadlineMetrics | null> {
  const rows = await db
    .select({
      id: prediction.id, won: predictionOutcome.won, returnPct: predictionOutcome.returnPct,
      alpha: predictionOutcome.alpha,
    })
    .from(prediction)
    .innerJoin(predictionOutcome, eq(prediction.id, predictionOutcome.predictionId))
    .where(and(
      eq(prediction.domain, input.domain),
      eq(prediction.configVersion, input.configVersion),
      eq(predictionOutcome.horizon, input.horizon),
      lte(prediction.createdAt, input.asOf),
    ));

  if (rows.length === 0) return null;

  const wins = rows.filter((r) => r.won).length;
  const returns = rows.map((r) => Number(r.returnPct));
  const alphas = rows.filter((r) => r.alpha !== null).map((r) => Number(r.alpha));
  const ci = rows.length >= 3 ? wilsonInterval(wins, rows.length, 0.95) : null;

  // Running-equity drawdown from a synthetic even-notional strategy — the trades' returns
  // compounded chronologically. Sorted by prediction createdAt.
  const chrono = [...rows].sort((a, b) => 0); // rows come from a single query — order fluctuates
  // Deterministic order: fetch a chronological-ordered slice
  const chronoOrdered = await db
    .select({ returnPct: predictionOutcome.returnPct })
    .from(prediction)
    .innerJoin(predictionOutcome, eq(prediction.id, predictionOutcome.predictionId))
    .where(and(
      eq(prediction.domain, input.domain),
      eq(prediction.configVersion, input.configVersion),
      eq(predictionOutcome.horizon, input.horizon),
      lte(prediction.createdAt, input.asOf),
    ))
    .orderBy(asc(prediction.createdAt));
  let equity = 1; let peak = 1; let maxDd = 0;
  for (const r of chronoOrdered) {
    equity *= (1 + Number(r.returnPct));
    if (equity > peak) peak = equity;
    const dd = peak > 0 ? (peak - equity) / peak : 0;
    if (dd > maxDd) maxDd = dd;
  }
  void chrono;

  return {
    domain: input.domain, configVersion: input.configVersion, horizon: input.horizon,
    n: rows.length, wins,
    accuracy: wins / rows.length,
    wilsonLower: ci?.lower ?? null,
    wilsonUpper: ci?.upper ?? null,
    medianReturn: median(returns),
    meanReturn: returns.reduce((a, b) => a + b, 0) / returns.length,
    meanAlpha: alphas.length > 0 ? alphas.reduce((a, b) => a + b, 0) / alphas.length : null,
    maxDrawdown: chronoOrdered.length > 0 ? maxDd : null,
  };
}

/**
 * By-horizon breakdown — the §32 "performance by horizon" cut. Version-isolated by required
 * `configVersion`; a caller wanting to compare v1 vs v2 must query each and diff explicitly.
 */
export async function byHorizon(
  db: Db,
  input: { domain: Domain; configVersion: number; asOf: Date; horizons: readonly string[] },
): Promise<HeadlineMetrics[]> {
  const out: HeadlineMetrics[] = [];
  for (const h of input.horizons) {
    const r = await headlineMetrics(db, { ...input, horizon: h });
    if (r) out.push(r);
  }
  return out;
}

/**
 * Precision / recall for a directional call. In a directional trading system these collapse to
 * accuracy for the "call the trade won" question — so we expose them here only to make future
 * §32 cuts (signal-vs-actual-direction, e.g.) cheap.
 */
export interface PrecisionRecall {
  readonly precision: number | null;
  readonly recall: number | null;
  readonly f1: number | null;
}

export function precisionRecall(input: { tp: number; fp: number; fn: number }): PrecisionRecall {
  const precision = input.tp + input.fp > 0 ? input.tp / (input.tp + input.fp) : null;
  const recall = input.tp + input.fn > 0 ? input.tp / (input.tp + input.fn) : null;
  const f1 = precision !== null && recall !== null && (precision + recall) > 0
    ? 2 * (precision * recall) / (precision + recall) : null;
  return { precision, recall, f1 };
}

/**
 * Bootstrap-state guard — a caller checking "should I trust any of these numbers yet?" per §32's
 * bootstrap-window discipline. Not a metric; an EXPLICIT insufficiency signal, same discipline
 * §8 uses for Setup Memory. The bar defaults to effective-n 30 (three times the §41 trust floor),
 * settable so a stricter domain can raise it.
 */
/**
 * Domain minimums for the §32 bootstrap-window bar (audit-2 finding: was one flat `minN=30`
 * for both, the plan is explicit that the maturity bar is per-domain and asymmetric):
 *   perp: 30 resolved predictions (three times the §41 trust floor)
 *   memecoin: 15 (memecoin has no historical backtest, so live evidence accumulates slower —
 *             a stricter bar would leave every metric permanently flagged).
 */
const DOMAIN_MIN_N: Record<Domain, number> = { perp: 30, memecoin: 15 };

export async function isBootstrapping(
  db: Db,
  input: {
    domain: Domain; configVersion: number; horizon: string; asOf: Date; minN?: number;
    /**
     * When true, count resolved predictions across ALL config versions in the domain, not just
     * `configVersion`. The maturity gate ("is this domain ripe enough to tune at all?") is a
     * domain-level question — it must NOT reset every time an operator edits an unrelated config
     * field (minRR, risk%) and bumps the active version. Version-isolation (Rule 16) governs
     * TRACK-RECORD attribution ("did v3 beat v2?"), a different question. promoteHypothesis passes
     * this. Default false preserves the version-isolated behavior for any track-record caller.
     */
    anyVersion?: boolean;
  },
): Promise<{ n: number; bootstrapping: boolean; message: string }> {
  const rows = await db
    .select({ n: count() })
    .from(prediction)
    .innerJoin(predictionOutcome, eq(prediction.id, predictionOutcome.predictionId))
    .where(and(
      eq(prediction.domain, input.domain),
      ...(input.anyVersion ? [] : [eq(prediction.configVersion, input.configVersion)]),
      eq(predictionOutcome.horizon, input.horizon),
      lte(prediction.createdAt, input.asOf),
    ));
  const n = Number(rows[0]?.n ?? 0);
  const minN = input.minN ?? DOMAIN_MIN_N[input.domain];
  const bootstrapping = n < minN;
  return {
    n,
    bootstrapping,
    message: bootstrapping
      ? `bootstrapping (${input.domain}): ${n} resolved < minN ${minN} — §32 bootstrap window applies, treat headline metrics as directional only`
      : `sufficient (${input.domain}): ${n} resolved ≥ minN ${minN}`,
  };
}

/** Small helpers kept exported for tests + reuse. */
export const _testing = { median, avg, sql };
