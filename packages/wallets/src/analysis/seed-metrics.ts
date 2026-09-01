/**
 * The Part II §4 seed-history analyses that settle the four placeholder tunables. Pure functions
 * over prepared inputs (the script does the DB loading), so they're deterministic and testable.
 *
 * Rigour varies by tunable and is stated honestly in the output doc:
 *  - batchingWindowMs + profitLadder rungs: directly measurable from co-buy spans + observed-swap
 *    post-entry maxima → solid.
 *  - walletExitThreshold + freshness τ: best-effort proxies at MVP (the fully rigorous versions
 *    need richer per-wallet-in-cluster sell sequencing) → treat as preliminary.
 */

/** Linear-interpolated quantile of unsorted values, q in [0,1]. */
export function quantile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return s[lo]!;
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

// ── 1. batchingWindowMs ───────────────────────────────────────
export interface BatchingWindowResult {
  n: number;
  p50: number | null;
  p80: number | null;
  p90: number | null;
  recommendedMs: number | null;
}
export function analyzeBatchingWindow(clusterSpansMs: readonly number[]): BatchingWindowResult {
  return {
    n: clusterSpansMs.length,
    p50: quantile(clusterSpansMs, 0.5),
    p80: quantile(clusterSpansMs, 0.8),
    p90: quantile(clusterSpansMs, 0.9),
    // Capture the bulk of real convergences without burning the tight memecoin TTL.
    recommendedMs: quantile(clusterSpansMs, 0.9),
  };
}

// ── 2. profitLadder rungs ─────────────────────────────────────
export interface LadderEntry {
  entryPrice: number;
  postEntryMaxPrice: number;
}
export interface ProfitLadderResult {
  n: number;
  reached: Record<string, number>; // fraction reaching each multiple
  suggestedRungs: { at: number; sellFraction: number }[];
}
export function analyzeProfitLadder(entries: readonly LadderEntry[]): ProfitLadderResult {
  const multiples = entries.filter((e) => e.entryPrice > 0).map((e) => e.postEntryMaxPrice / e.entryPrice);
  const n = multiples.length;
  const frac = (x: number): number => (n === 0 ? 0 : multiples.filter((m) => m >= x).length / n);
  const reached = { '2x': frac(2), '3x': frac(3), '5x': frac(5), '10x': frac(10) };

  // Place a rung only where a meaningful fraction of clusters actually reach it.
  const suggestedRungs: { at: number; sellFraction: number }[] = [];
  if (reached['2x'] >= 0.2) suggestedRungs.push({ at: 2, sellFraction: 0.5 });
  if (reached['3x'] >= 0.1) suggestedRungs.push({ at: 3, sellFraction: 0.25 });
  if (reached['5x'] >= 0.05) suggestedRungs.push({ at: 5, sellFraction: 0.15 });
  return { n, reached, suggestedRungs };
}

// ── 3. walletExitThreshold (best-effort proxy) ────────────────
export interface WalletExitResult {
  n: number;
  meanFullExitFraction: number | null; // mean over clusters of (wallets that fully exited / wallets)
  fracClustersMostlyDumped: number; // clusters where ≥90% of wallets fully exited
  note: string;
}
export function analyzeWalletExit(clusterFullExitFractions: readonly number[]): WalletExitResult {
  const n = clusterFullExitFractions.length;
  const mean = n === 0 ? null : clusterFullExitFractions.reduce((a, b) => a + b, 0) / n;
  const mostly = n === 0 ? 0 : clusterFullExitFractions.filter((f) => f >= 0.9).length / n;
  return {
    n,
    meanFullExitFraction: mean,
    fracClustersMostlyDumped: mostly,
    note: 'Proxy: final per-cluster exit completeness, not the temporal partial→dump sequence. If clusters mostly fully dump, the 0.9 default is well-supported; a low value argues for a lower threshold. Refine with sell-sequence data post-launch.',
  };
}

// ── 4. freshness τ (best-effort) ──────────────────────────────
export interface FreshnessSample {
  delayMs: number; // buy time − cluster first-buy
  forwardReturn: number; // e.g. 1h peak return from that buy
}
export interface FreshnessResult {
  n: number;
  buckets: { maxDelayMs: number; meanReturn: number | null; count: number }[];
  tauMsEstimate: number | null; // delay at which mean return decays to 1/e of the freshest bucket
}
export function analyzeFreshness(samples: readonly FreshnessSample[], bucketEdgesMs: readonly number[] = [5_000, 15_000, 30_000, 60_000, 300_000]): FreshnessResult {
  const buckets = bucketEdgesMs.map((maxDelayMs, i) => {
    const lo = i === 0 ? 0 : bucketEdgesMs[i - 1]!;
    const inBucket = samples.filter((s) => s.delayMs > lo && s.delayMs <= maxDelayMs).map((s) => s.forwardReturn);
    const meanReturn = inBucket.length === 0 ? null : inBucket.reduce((a, b) => a + b, 0) / inBucket.length;
    return { maxDelayMs, meanReturn, count: inBucket.length };
  });
  const first = buckets.find((b) => b.meanReturn !== null)?.meanReturn ?? null;
  let tauMsEstimate: number | null = null;
  if (first !== null && first > 0) {
    const threshold = first / Math.E;
    tauMsEstimate = buckets.find((b) => b.meanReturn !== null && b.meanReturn <= threshold)?.maxDelayMs ?? null;
  }
  return { n: samples.length, buckets, tauMsEstimate };
}
