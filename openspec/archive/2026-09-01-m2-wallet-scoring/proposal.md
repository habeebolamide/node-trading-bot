# Change: m2-wallet-scoring

> **COMPLETED 2026-09-01.** Shipped the §4/Task-6 scoring into `packages/wallets`: `stats.ts`
> (Beta-Binomial shrinkage, percentile rank), `price-series.ts` (observed-swap series + forward
> returns, null-on-gap), `early-entry.ts` (per-wallet aggregate → `trade_outcome` + coverage),
> `metrics.ts` (the seven sub-metrics), `scoring.ts` (universe percentile-normalize + weighted
> composite + UNRATED gate), `score-log.ts` (append-only `WalletScoreEvent` + `walletScoreAsOf(T)`
> with NO current-score accessor — rule 21), `config.ts` (domain-level versioned
> `WalletScoringConfig`, seeds the §4 default weights), and `recompute.ts` (`scoreAllWallets` full
> pass). Migration 0003 (wallet, wallet_score_event, brain_wallet_memory, wallet_scoring_config,
> trade_outcome) applied.
>
> **Verified:** typecheck green; **95/98 tests pass** (3 opt-in live skipped). Mandatory units:
> shrinkage (2/2 < 350/500, n=0→base, monotonic), percentile normalization (boundaries,
> single-wallet, empty), forward returns (null-on-gap, coverage, peak, entryPrice guard), scoring
> (ordering, weight renormalization). Live-Postgres pass: a 12-trade wallet is RATED and scored, a
> 3-trade wallet stays UNRATED with no score event, `walletScoreAsOf` never returns the future, and
> profiles reflect status.
>
> **Deviations from spec:** none material. Both sign-off items confirmed by the user (domain-level
> WalletScoringConfig; the MVP sub-metric formulas). The per-25-trades incremental trigger reuses
> the full pass for MVP (cheap at ~100 wallets); a true incremental path is a documented later
> optimization. Next: m2-seed-analysis (needs the ~100-wallet roster).

**Status:** COMPLETED — archived
**Original status:** PROPOSED (scoping — awaiting review)
**Milestone:** M2 — Wallet Intelligence (§30), change 2 of 3
**Implements:** Part II §3 (early-entry edge), §4 (wallet scoring, `WalletScoreEvent`, backfill),
Task 6 (§34 — Beta-Binomial shrinkage, percentile normalization, n<10 unrated, recompute trigger),
§13 (`Wallet`, `WalletScoreEvent`, `BrainWalletMemory`, `TradeOutcome`), §40.17 (Early-Entry Edge
feature reads `BrainWalletMemory`). §33 rules 8/11/16/21/23.

**Depends on:** m2-trade-reconstruction (needs `wallet_trade`).
**Decision baked in:** Early-Entry Edge uses the **observed-swap price approximation** (chosen at
scoping): a sparse per-token price series assembled from the union of wallets' own swaps; horizons
with no nearby swap are `unknown`, never fabricated.

## Why

This is the milestone's payload: an objective, point-in-time, versioned wallet score. It converts
reconstructed trades into the seven §4 sub-metrics, normalizes and weights them into a 0–100 score,
and records every recompute in an append-only log so any historical "score as of T" read is exact
(rule 21 — the structural guard the whole backtest discipline depends on).

## What changes

`packages/wallets` grows:

- **`price-series.ts`** — build a sparse per-token price series from `wallet_transaction`
  (price = `amountSol / tokenAmount` per swap); `forwardReturns(entryPrice, entryTime, series,
  horizons)` → `{ '5m': +0.04 | null, … }`, `null` where no swap lands near a horizon.
- **`early-entry.ts`** — per wallet, aggregate forward-return stats across its entries (peak
  forward return across horizons is the headline signal, §3). Feeds `BrainWalletMemory`.
- **`metrics.ts`** — the seven §4 sub-metrics from a wallet's trades: Profitability, Win Rate,
  Early-Entry Edge, Consistency, Memecoin Specialization, Trade Quality, Corroboration. Rate
  sub-metrics use **Beta-Binomial shrinkage** toward the universe base rate (`shrunk =
  (wins+α₀)/(n+α₀+β₀)`) so 2-for-2 can't outrank 350-for-500 (Task 6).
- **`scoring.ts`** — percentile-normalize each sub-metric to [0,100] across the rated universe,
  weight by the versioned config, sum → score. `n < 10 trades → UNRATED` (excluded from the
  universe and from convergence weighting, §4).
- **`score-log.ts`** — append `WalletScoreEvent { walletId, timestamp, newScore, inputsUsed }` on
  each recompute; `walletScoreAsOf(walletId, T)` = latest event with `timestamp ≤ T`. **No
  `currentScore()` method is exported to any backtest path** (rule 21, enforced by the module's
  surface).
- **`recompute.ts`** — trigger a recompute every **25 new trades or a daily job** (§4); emit
  `wallet.score.updated` (+ `wallet.profile.updated` on profile changes).
- **`WalletScoringConfig`** — a **domain-level**, append-only versioned config (weights, shrinkage
  priors, thresholds). *Resolved solo:* this is separate from the per-TradingAgent `ScoringConfig`
  (§8), because a wallet score is a shared Brain fact (§15), not a per-agent opinion. Flagged for
  sign-off.

Schema (migration 0003): `wallet` (profile), `wallet_score_event` (append-only, indexed
`(wallet_id, timestamp)` for as-of lookups), `brain_wallet_memory` (per-wallet early-entry +
behavioral stats), `wallet_scoring_config` (versioned), and `trade_outcome` (the multi-horizon
forward returns per trade, deferred from change 1).

## Build-time sub-metric definitions to settle in design.md (flag)

§4 names the seven metrics and their weights but leaves several formulas open. Proposed MVP
definitions (to confirm in review): **Consistency** = 1 − normalized dispersion of realized
returns (down-weighted by drawdown); **Memecoin Specialization** = fraction of activity that is
memecoin swaps (≈1.0 in MVP since Helius only watches Solana swaps — low signal early, kept for
when the universe widens); **Trade Quality** = size-vs-liquidity / realized-slippage proxy;
**Corroboration** = overlap with other high-scoring wallets on the same tokens (small 5% weight,
computed after a first scoring pass exists). Each is percentile-normalized, so exact scale matters
less than monotonic ordering.

## What this change does NOT do

- No convergence / funder clustering (M3) — early-entry aggregates per wallet, not per cluster.
- No automated discovery (M3).
- No live token price API — observed-swap approximation only (the scoping decision).
- Does not tune the four placeholder tunables — that's change 3 (seed analysis).
