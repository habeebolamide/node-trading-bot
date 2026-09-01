/**
 * Convergence aggregation (Part II §5, §9, Task 6, §40.8). Pure: given a batch of buys on ONE
 * mint plus the active `wallet → cluster` map, compute per-cluster stats and the composite
 * convergence score.
 *
 *   convergence_score = Σ (clusterQuality × independenceWeight) × timeCompression
 *
 * where:
 *   - clusterQuality = capped avg wallet score across cluster members present in the batch
 *   - independenceWeight = 1.0 in v1 (primary heuristic only; secondary CEX-withdrawal is a
 *     future add without a schema break, §5)
 *   - timeCompression: 1.0 at ~0 span, tapering to 0.5 at batching-window boundary (§40.8)
 *
 * Wallets NOT in the cluster map are treated as their own "solo:<wallet>" cluster (independent
 * singletons still contribute, thinly) — matches §40.8 "single cluster in batch → still produces
 * a score (thin contribution), does not fail the batch."
 */

export interface Buy {
  wallet: string;
  walletScore: number;
  amountSol: string;
  tokenAmount: string;
  blockTime: string; // ISO
  signature: string;
}

export interface AggregateOptions {
  batchingWindowMs: number;
  /** Cap on any one cluster's clusterQuality contribution (Task 6). Default 100. */
  clusterQualityCap?: number;
}

export interface PerCluster {
  clusterId: string; // 'cluster:<id>' or 'solo:<wallet>'
  wallets: string[];
  totalSol: string;
  clusterQuality: number; // capped
  independenceWeight: number;
}

export interface ConvergenceResult {
  convergenceScore: number;
  independentClusterCount: number;
  timeCompression: number;
  batchSpanMs: number;
  perCluster: PerCluster[];
}

/** Linear taper from 1.0 (span=0) → 0.5 (span=windowMs). Clamped to [0.5, 1.0]. */
export function timeCompressionFor(spanMs: number, windowMs: number): number {
  if (spanMs <= 0) return 1.0;
  if (spanMs >= windowMs) return 0.5;
  return 1.0 - 0.5 * (spanMs / windowMs);
}

export function aggregate(
  batch: readonly Buy[],
  clusterByWallet: ReadonlyMap<string, string>,
  opts: AggregateOptions,
): ConvergenceResult {
  const cap = opts.clusterQualityCap ?? 100;

  // Dedup buys by (wallet, signature) — a same tx re-arriving shouldn't double-count.
  const seen = new Set<string>();
  const deduped: Buy[] = [];
  for (const b of batch) {
    const key = `${b.wallet}|${b.signature}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(b);
  }

  // Group by cluster id (real cluster or solo:<wallet>).
  const groups = new Map<string, Buy[]>();
  for (const b of deduped) {
    const cid = clusterByWallet.get(b.wallet) ?? `solo:${b.wallet}`;
    const key = cid.startsWith('solo:') ? cid : `cluster:${cid}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(b);
  }

  const perCluster: PerCluster[] = [];
  let score = 0;
  for (const [clusterId, buys] of groups) {
    const walletsSet = new Set<string>();
    let totalSolNum = 0;
    let scoreSum = 0;
    for (const b of buys) {
      walletsSet.add(b.wallet);
      totalSolNum += Number(b.amountSol);
      scoreSum += b.walletScore;
    }
    const wallets = [...walletsSet];
    const rawQuality = scoreSum / buys.length;
    const clusterQuality = Math.min(rawQuality, cap);
    const independenceWeight = 1.0;
    perCluster.push({
      clusterId,
      wallets,
      totalSol: String(totalSolNum),
      clusterQuality,
      independenceWeight,
    });
    score += clusterQuality * independenceWeight;
  }

  // Time compression over the batch span.
  const times = deduped.map((b) => new Date(b.blockTime).getTime()).sort((a, b) => a - b);
  const spanMs = times.length >= 2 ? times[times.length - 1]! - times[0]! : 0;
  const compression = timeCompressionFor(spanMs, opts.batchingWindowMs);
  score *= compression;

  return {
    convergenceScore: score,
    independentClusterCount: perCluster.length,
    timeCompression: compression,
    batchSpanMs: spanMs,
    perCluster,
  };
}
