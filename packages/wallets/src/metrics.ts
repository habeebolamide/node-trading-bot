/**
 * The seven §4 wallet sub-metrics, computed from a wallet's CLOSED trades (+ its early-entry
 * aggregate). Raw values here are percentile-normalized across the universe in scoring.ts, so what
 * matters is monotonic ordering, not absolute scale. Rate metrics use Beta-Binomial shrinkage.
 *
 * MVP formulas (confirmed at scoping): Consistency = 1/(1+stddev of returns); Memecoin
 * Specialization = 1.0 (all Helius activity is Solana memecoin in MVP — neutral until the universe
 * widens); Trade Quality = median position size (SOL) as a conviction/quality proxy; Corroboration
 * = co-occurrence with other rated wallets (computed in the pass, passed in here).
 */
import { betaBinomialShrunk, median, stddev } from './stats.js';

export interface TradeForMetrics {
  status: 'OPEN' | 'CLOSED';
  realizedReturnPct: number | null;
  won: boolean | null;
  totalSolIn: number;
}

export interface EarlyEntryAggregate {
  peakMedian: number | null;
  coverage: number; // 0..1
}

export interface RawMetrics {
  profitability: number;
  winRate: number;
  earlyEntry: number;
  consistency: number;
  specialization: number;
  tradeQuality: number;
  corroboration: number;
  /** CLOSED trade count — the sample size behind these. */
  n: number;
}

export const METRIC_KEYS = [
  'profitability', 'winRate', 'earlyEntry', 'consistency', 'specialization', 'tradeQuality', 'corroboration',
] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];

export function computeRawMetrics(
  trades: readonly TradeForMetrics[],
  earlyEntry: EarlyEntryAggregate,
  priors: { alpha: number; beta: number },
  corroboration: number,
): RawMetrics {
  const closed = trades.filter((t) => t.status === 'CLOSED');
  const returns = closed.map((t) => t.realizedReturnPct).filter((r): r is number => r !== null);
  const wins = closed.filter((t) => t.won === true).length;
  const n = closed.length;

  return {
    profitability: median(returns) ?? 0,
    winRate: betaBinomialShrunk(wins, n, priors.alpha, priors.beta),
    // Down-weight thin coverage honestly: a wallet whose early-entry stats rest on few observed
    // horizons contributes proportionally less (the wide-CI analogue).
    earlyEntry: (earlyEntry.peakMedian ?? 0) * earlyEntry.coverage,
    consistency: 1 / (1 + stddev(returns)),
    specialization: 1.0, // MVP: all activity is Solana memecoin (neutral across the universe)
    tradeQuality: median(closed.map((t) => t.totalSolIn)) ?? 0,
    corroboration,
    n,
  };
}
