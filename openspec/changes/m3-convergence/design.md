# Design: m3-convergence

Read Part II §5, §9, §9a, Task 6, and §40.8 alongside.

## Flow

```
memecoin.wallet.buy.detected (from m3-watchlist BuyDetector)
    → Batcher: per-mint pen; opens on first buy, closes after batchingWindowMs
    → on close:
         raw batch → filter: skip if token claim active (§9a) — stub in M3
         load active clusters (join wallet_cluster where cluster_run.status='active')
         group batch by (cluster_id | ungrouped-single-wallet)
         compute per-cluster { clusterQuality (capped avg wallet score), memberCount, totalSol }
         convergence_score = Σ (clusterQuality × independenceWeight) × timeCompression
         if compositeMeetsFloor(convergence_score, config):
            emit memecoin.wallet.convergence.detected {
              mint, batchOpenedAt, batchClosedAt,
              buys[], clusters[], convergenceScore, independentClusterCount,
              signalTtlMs   -- from trading-style-agnostic default (10m memecoin)
            }
```

Batching is in-memory per worker instance (no Redis) — the batching window is small (default
5s) and the memecoin fast lane requirement (§11) means we should decide immediately anyway. A
worker restart drops in-flight batches; that's acceptable because the same buys will be
re-published if the queue redelivers, and losing a 5s batch is far less bad than deferring the
signal by seconds.

## Aggregator (pure)

```
aggregate(batch, clusters, config):
  # group each buy by its wallet's cluster (or a synthetic id for un-clustered wallets)
  perCluster = new Map<clusterId, {wallets, buys, quality, totalSol}>
  for buy in batch:
    cid = clusters.get(buy.wallet)?.clusterId ?? `solo:${buy.wallet}`
    // one row per cluster: dedup wallets, sum SOL, cap quality
  clusterQuality[c] = cap(avg(wallet_scores in c), CAP)     # Task 6 cap
  independenceWeight[c] = 1.0   // v1: primary heuristic only; secondary in a follow-up
  timeCompression = compressionFor(batchSpanMs)             # 1.0 tight → 0.5 at window boundary
  score = sum(clusterQuality[c] * independenceWeight[c]) * timeCompression
  return { score, perCluster: [...], independentCount: perCluster.size }
```

`compressionFor` linearly interpolates from 1.0 (spanMs≈0) to 0.5 (spanMs≈batchingWindowMs).
That matches §40.8 ("1.0 for very tight windows, tapering to 0.5 at the batching-window
boundary").

## Testing

Unit (pure):
- `aggregate()` — one cluster of 3 vs three solo wallets → the first has higher independentCount.
  Five wallets same funder → one cluster (dedup works). timeCompression → correct at 0/mid/edge.
- `Batcher` — opens on first buy, closes at window+ε, multiple mints run independent pens.

Integration (live DB, in-memory bus):
- Feed 3 buys on the same mint from 3 different clusters → one convergence event emitted with
  independentClusterCount=3. Feed 5 buys on same mint from 1 shared funder → event with
  independentClusterCount=1.
