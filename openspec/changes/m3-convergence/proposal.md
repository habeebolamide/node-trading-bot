# Change: m3-convergence

**Status:** PROPOSED (scoping — awaiting review)
**Milestone:** M3 — Smart Money Radar (§30), change 3 of 3 (final)
**Implements:** Part II §5 (funder-dedup convergence), §9a (batching window,
`memecoin.wallet.buy.detected` fan-in), Task 6 (convergence math). §33 rules 12/17/19.
**Depends on:** m3-watchlist (emits the input event), m3-funder-clustering (dedup source).

## Why

`Convergence` is 20% of the memecoin composite (§9) and the highest-conviction memecoin signal
available before any price/volume follow-through. It fires when multiple **independent** smart
wallets buy the same token in a short window — but "independent" is what funder-clustering
(change 2) enables: five wallets from one funder = one signal, not five. This change ties it
together and emits `memecoin.wallet.convergence.detected` — the event the Convergence Agent
(§40.8, M4) consumes.

## What changes

`packages/watchlist` grows (or `packages/convergence` — TBD in design):

- **`batching.ts`** — the §9a batching-pen: incoming `memecoin.wallet.buy.detected` events for
  the same mint collect into an in-memory batch that closes after `batchingWindowMs` from the
  first buy. When it closes, hand the batch to `ConvergenceAggregator`.
- **`aggregator.ts`** — pure: given a batch of buys + the active clusters, group by cluster,
  compute Task-6 convergence score
  `Σ_clusters (clusterQuality × independenceWeight) × timeCompression`, decide whether to emit.
- **`emitter.ts`** — publishes `memecoin.wallet.convergence.detected` with the full evidence
  package (participating wallets, cluster ids, buy sizes, per-cluster quality, composite).
- **`claim.ts`** — the platform-wide token claim pre-filter (§9a): drop buys on a token already
  IN_TRADE by any TradingAgent (no TradingAgents yet, so this is a no-op stub with the DB
  check ready to wire when M4 lands — flagged in design).

Config additions to `WalletScoringConfig` are **out** — the batching window and thresholds
belong in a new memecoin-specific config (or in `ScoringConfig` when it lands at M4). For M3
they live in a small module constant, with a comment pointer to §9a and §4 seed-analysis so
they're findable when M4 wires the real config.

Schema (migration 0006): none required — the emitted event is durable via `domain_event`
(existing), and cluster/watched/score data all live elsewhere. If we need
`memecoin_convergence_event` for querying + attribution later, that's a light add.

## What this change does NOT do

- No selection-pass / TradingAgent assignment (§9a) — that's M4 (needs TradingAgents).
- No token-claim enforcement — the pre-filter is a stub until M4.
- No profit-ladder / exit-threshold logic — those live in the Trade Planner (M4/M6).
- No wallet-exit event (`memecoin.wallet.exit.detected`) — the same batching machinery can
  drive it, but sells behave differently enough (Part II §10) that it belongs in M4 with the
  Paper Engine.

## Resolved solo (flag)

- **Batching window default** = 5000ms (the plan's stated §9a placeholder), documented as
  such; the M2-seed-analysis result would tune it but we're using the placeholder for M3.
- **Minimum independent clusters to emit** = 1 (thin-single-cluster still fires, §40.8 says
  "still gets scored, does not fail the batch") but confidence scales with independent count.
