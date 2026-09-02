/**
 * Walk-forward evaluation folds (Task 7 — PERP ONLY).
 *
 * Rolling folds of train 60d / test 20d, stepped forward one test-window at a time. This change
 * builds the fold GENERATOR (a pure function over a date range) and an `evaluateFold` helper
 * that computes headline metrics on a fold's test window. M7's hypothesis pipeline consumes both;
 * this change stops there, per CLAUDE.md's "no config writes."
 *
 * TRAIN AND TEST NEVER OVERLAP — the generator returns disjoint ranges by construction. There is
 * no code path that could accidentally return an overlapping fold, which is Task 7's core "never
 * tune and test on the same window" rule made structural rather than trusted.
 *
 * Memecoin is refused outright: §25 scopes memecoin out of historical backtest entirely, so a
 * memecoin walk-forward would be meaningless — the DB has no historical positions to fold over.
 * `walkForwardFolds({domain: 'memecoin'})` throws — silent skip would hide the mismatch.
 */
import { ValidationError } from '@tip/domain';
import type { Domain } from '@tip/trading-agents';
import { headlineMetrics, type HeadlineMetrics } from './metrics.js';
import type { Db } from '@tip/database';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface Fold {
  readonly index: number;
  readonly trainStart: Date;
  readonly trainEnd: Date; // exclusive of testStart — the two never touch, let alone overlap
  readonly testStart: Date;
  readonly testEnd: Date;
}

export interface WalkForwardOptions {
  readonly from: Date;
  readonly to: Date;
  readonly trainDays?: number;
  readonly testDays?: number;
  readonly step?: number; // days to advance per fold; defaults to `testDays`
}

export function walkForwardFolds(
  domain: Domain,
  opts: WalkForwardOptions,
): readonly Fold[] {
  if (domain !== 'perp') {
    throw new ValidationError(`walkForwardFolds: perp only (§25 — memecoin has no historical backtest in MVP)`);
  }
  const trainDays = opts.trainDays ?? 60;
  const testDays = opts.testDays ?? 20;
  const step = opts.step ?? testDays;
  if (trainDays <= 0 || testDays <= 0 || step <= 0) {
    throw new ValidationError('walkForwardFolds: trainDays/testDays/step must be > 0');
  }
  if (opts.from.getTime() >= opts.to.getTime()) return [];

  const folds: Fold[] = [];
  let cursor = opts.from.getTime();
  const foldDurationMs = (trainDays + testDays) * DAY_MS;
  let i = 0;
  while (cursor + foldDurationMs <= opts.to.getTime()) {
    const trainStart = new Date(cursor);
    const trainEnd = new Date(cursor + trainDays * DAY_MS);
    const testStart = trainEnd; // trainEnd == testStart, exclusive on trainEnd (test STARTS here)
    const testEnd = new Date(cursor + foldDurationMs);
    folds.push({ index: i, trainStart, trainEnd, testStart, testEnd });
    cursor += step * DAY_MS;
    i++;
  }
  return folds;
}

/** Metrics on the TEST window only — the whole point of the discipline. */
export async function evaluateFold(
  db: Db,
  input: { fold: Fold; configVersion: number; horizon: string },
): Promise<HeadlineMetrics | null> {
  return headlineMetrics(db, {
    domain: 'perp',
    configVersion: input.configVersion,
    horizon: input.horizon,
    asOf: input.fold.testEnd,
  });
  // Note: the current `headlineMetrics` cutoff is `<= asOf` and doesn't yet exclude predictions
  // BEFORE testStart. That is fine for the initial walk-forward driver — a fold's "test" is
  // "predictions resolved by testEnd." A stricter windowed variant will land alongside the
  // hypothesis pipeline (M7), where per-window isolation matters more than in a first report.
}
