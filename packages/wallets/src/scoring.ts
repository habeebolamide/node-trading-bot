/**
 * Composite wallet score (§4). Each raw sub-metric is percentile-normalized to [0,100] across the
 * rated universe, then weighted and summed. Percentile normalization couples wallets (a wallet's
 * score is relative to its peers), so this operates on the whole rated set at once.
 *
 * `n < unratedMinTrades` wallets are UNRATED — excluded from the universe entirely (not scored,
 * not part of anyone's percentile base), per §4.
 */
import { percentileRank } from './stats.js';
import { METRIC_KEYS, type MetricKey, type RawMetrics } from './metrics.js';

export type Weights = Record<MetricKey, number>;

export interface ScoredWallet {
  walletId: string;
  score: number; // 0..100
  percentiles: Record<MetricKey, number>;
  raw: RawMetrics;
}

/**
 * Score every RATED wallet. Input is the raw metrics per wallet (already filtered to rated —
 * callers drop n<unratedMinTrades first). Weights are renormalized to sum to 1 defensively.
 */
export function scoreUniverse(rawByWallet: ReadonlyMap<string, RawMetrics>, weights: Weights): ScoredWallet[] {
  const wallets = [...rawByWallet.keys()];
  if (wallets.length === 0) return [];

  // Per-metric population across the universe.
  const population: Record<MetricKey, number[]> = Object.fromEntries(
    METRIC_KEYS.map((k) => [k, wallets.map((w) => rawByWallet.get(w)![k])]),
  ) as Record<MetricKey, number[]>;

  const weightSum = METRIC_KEYS.reduce((s, k) => s + (weights[k] ?? 0), 0) || 1;

  return wallets.map((walletId) => {
    const raw = rawByWallet.get(walletId)!;
    const percentiles = {} as Record<MetricKey, number>;
    let score = 0;
    for (const k of METRIC_KEYS) {
      const p = percentileRank(raw[k], population[k]);
      percentiles[k] = p;
      score += ((weights[k] ?? 0) / weightSum) * p;
    }
    return { walletId, score, percentiles, raw };
  });
}
