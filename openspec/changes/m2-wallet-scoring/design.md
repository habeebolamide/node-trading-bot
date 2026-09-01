# Design: m2-wallet-scoring

Read Part II §3/§4 and Task 6 alongside. Reuses `wilsonInterval`-style rigor from §41 (the
Beta-Binomial shrinkage here is the wallet-score analogue).

## Sub-metrics (metrics.ts) — inputs are a wallet's CLOSED wallet_trades

| Metric (weight) | MVP definition |
|---|---|
| Profitability (20%) | weighted median realized return + profit factor (Σ wins / Σ losses, SOL) |
| Win Rate (15%) | Beta-Binomial shrunk win rate: `(wins+α₀)/(n+α₀+β₀)`, priors from universe base rate |
| Early-Entry Edge (25%) | peak forward return across horizons, aggregated per wallet (early-entry.ts) |
| Consistency (15%) | 1 − normalized stddev of realized returns, penalized by max drawdown |
| Memecoin Specialization (10%) | fraction of activity in memecoin swaps (≈1 in MVP; kept for a wider universe) |
| Trade Quality (10%) | size-vs-pool / realized-slippage proxy from swap prices |
| Corroboration (5%) | co-occurrence with other high-score wallets on the same tokens (2nd pass) |

Each raw sub-metric → **percentile across the rated universe** → [0,100] (Task 6). Composite =
Σ weightᵢ · percentileᵢ, weights from `WalletScoringConfig`. `n<10 trades → UNRATED` (not in the
universe, not scored, excluded from convergence — §4).

## Early-entry via observed swaps (the scoping decision)

```
per token, series = [(blockTime, amountSol/tokenAmount) for every swap on that mint], ascending
per wallet entry (a BUY): entryPrice, entryTime
  for h in [5m,15m,30m,1h,6h,24h]:
    p = first series point with time ≥ entryTime + h, within a tolerance window
    fwdReturn[h] = p ? (p.price - entryPrice)/entryPrice : null   # null = unknown, never 0-filled
aggregate across the wallet's entries → BrainWalletMemory.earlyEntry { perHorizonMedian, peakMedian, coverage }
```

`coverage` (fraction of horizons that had a nearby swap) is stored so the score can down-weight a
wallet whose early-entry stats are thin — the honest-uncertainty analogue of a wide Wilson interval.
Improves automatically as live swap volume fills the series (no backfill of chain-wide price needed).

## Point-in-time score log (score-log.ts) — rule 21, structural

`wallet_score_event` is append-only (rule 8/16). `walletScoreAsOf(walletId, T)` = the latest row
with `timestamp ≤ T`. The module deliberately exports **no** `currentScore()` / `latest()` — the
only score accessor takes a T. A "give me the newest" need (live path, dashboards) is served by a
separate explicitly-named `liveScore()` that is NOT importable from `@tip/evaluation` replay code
(kept in a different entrypoint), mirroring §25's "the backtest data-access layer must not expose a
current-score method." Same discipline as M1's `AsOfMarketData`.

## Recompute trigger (recompute.ts)

A wallet recomputes when it has accrued **25 new trades since its last score**, or on a **daily
job** (§4). Recompute: pull its closed trades → sub-metrics → (needs universe percentiles: computed
over all rated wallets in the same pass) → composite → append `WalletScoreEvent` → emit
`wallet.score.updated`. Percentile normalization couples wallets (a new wallet shifts percentiles),
so the daily job recomputes the universe together; the per-25-trades trigger recomputes just that
wallet against the last known universe distribution (cheap, slightly stale — acceptable, corrected
by the daily pass).

## WalletScoringConfig (versioned, domain-level)

Append-only rows `{ version, weights{7}, shrinkagePriors{α₀,β₀}, unratedMinTrades:10,
recomputeEveryNTrades:25, createdAt, active }`. Every `WalletScoreEvent.inputsUsed` records the
`configVersion` that produced it, so a weight change never silently blends score history (the same
discipline as `Prediction.configVersion`, §19). **Distinct from per-TradingAgent `ScoringConfig`.**

## Schema (migration 0003)

`wallet`, `wallet_score_event` (append-only), `brain_wallet_memory`, `wallet_scoring_config`,
`trade_outcome` (per-trade forward returns + realized outcome). Details in tasks.

## Testing (mandatory-per-CLAUDE.md items)

- **Beta-Binomial shrinkage**: 2-for-2 scores below 350-of-500; n=0 → base rate; monotonic.
- **percentile normalization**: weights sum, boundary values (min→0, max→100), single-wallet universe.
- **walletScoreAsOf**: never returns a score with `timestamp > T`; returns the correct latest ≤ T;
  n<10 wallet → UNRATED (this is the §CLAUDE.md "wallet score as of T must never return today's").
- **early-entry**: null horizons stay null (no 0-fill); coverage computed; peak picked correctly.
- integration (live DB): recompute a seeded wallet → one WalletScoreEvent appended, as-of reads it.
