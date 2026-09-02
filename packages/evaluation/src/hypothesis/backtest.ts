/**
 * Backtest + out-of-sample confirmation (§24 last paragraph). Reuses `walkForwardFolds` +
 * `evaluateFold` from m6-attribution-metrics — the exact primitives Task 7 asks for.
 *
 * "Improvement" = strict: accuracy AND meanAlpha both up, non-overlapping Wilson intervals.
 * The Wilson requirement is the same "no measurable difference" bar M6c5's factor tertile
 * check uses. This is the ONLY discipline strong enough to keep a permanent config change
 * honest (§24 hard rule).
 */
import type { Db } from '@tip/database';
import type { HeadlineMetrics } from '../metrics/metrics.js';
import { headlineMetrics } from '../metrics/metrics.js';
import { walkForwardFolds, type Fold } from '../metrics/walk-forward.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface BacktestConfig {
  readonly db: Db;
  readonly configVersion: number;
  readonly horizon: string;
  readonly range: { from: Date; to: Date };
  readonly trainDays?: number;  // default 60
  readonly testDays?: number;   // default 20
}

/** Pick the last fold in the range whose train window fully fits — that's the most recent
 *  "we could have tested this" opportunity a proposal earns. */
export function pickBacktestFold(opts: BacktestConfig): Fold | null {
  const folds = walkForwardFolds('perp', {
    from: opts.range.from, to: opts.range.to,
    ...(opts.trainDays !== undefined ? { trainDays: opts.trainDays } : {}),
    ...(opts.testDays !== undefined ? { testDays: opts.testDays } : {}),
  });
  return folds.length === 0 ? null : folds[folds.length - 1]!;
}

/** OOS fold = a HELD-OUT LATER window immediately following the backtest fold. Same size. */
export function pickOOSFold(backtest: Fold, testDays = 20): Fold | null {
  const trainStart = backtest.testEnd;
  const trainEnd = new Date(trainStart.getTime() + testDays * DAY_MS);
  const testStart = trainEnd;
  const testEnd = new Date(testStart.getTime() + testDays * DAY_MS);
  return { index: backtest.index + 1, trainStart, trainEnd, testStart, testEnd };
}

/** Metrics on a fold's test window under the configVersion in question. */
export async function evaluateFoldWindow(
  db: Db,
  input: { configVersion: number; horizon: string; asOf: Date },
): Promise<HeadlineMetrics | null> {
  return headlineMetrics(db, {
    domain: 'perp', configVersion: input.configVersion, horizon: input.horizon, asOf: input.asOf,
  });
}

/**
 * Improvement check: BOTH windows show a proposed variant beating the incumbent on accuracy
 * AND meanAlpha, AND the Wilson intervals of accuracy do not overlap. §24 verbatim: "improvement
 * whose Wilson intervals overlap is not an improvement."
 *
 * The pipeline calls this against a PROPOSED config running headlineMetrics under the new
 * weights. Since MVP does not include a "config-runtime override for backtest" seam yet, this
 * function stays pure over two provided HeadlineMetrics results — the wiring layer supplies
 * both. It's a build-time simplification that keeps the promotion rule reviewable.
 */
export function isImprovement(
  incumbent: HeadlineMetrics | null,
  proposed: HeadlineMetrics | null,
): { improved: boolean; reason: string } {
  if (!incumbent || !proposed) return { improved: false, reason: 'null metrics on one side' };
  if (proposed.accuracy === null || incumbent.accuracy === null) {
    return { improved: false, reason: 'null accuracy' };
  }
  if (proposed.meanAlpha === null || incumbent.meanAlpha === null) {
    return { improved: false, reason: 'null alpha' };
  }
  const accuracyUp = proposed.accuracy > incumbent.accuracy;
  const alphaUp = proposed.meanAlpha > incumbent.meanAlpha;
  if (!accuracyUp || !alphaUp) return { improved: false, reason: 'accuracy or alpha not up' };
  // Wilson intervals: require the proposed LOWER bound to exceed the incumbent UPPER bound.
  if (proposed.wilsonLower === null || incumbent.wilsonUpper === null) {
    return { improved: false, reason: 'Wilson not computed on one side' };
  }
  if (proposed.wilsonLower <= incumbent.wilsonUpper) {
    return { improved: false, reason: 'Wilson intervals overlap — no measurable difference (§24 gate)' };
  }
  return { improved: true, reason: 'accuracy up, alpha up, Wilson intervals disjoint' };
}
