# Change: m3-funder-clustering

**Status:** PROPOSED (scoping — awaiting review)
**Milestone:** M3 — Smart Money Radar (§30), change 2 of 3
**Implements:** Part II §5 (interim funder-clustering heuristic — "buildable now from data
already being ingested, no new provider needed"), Task 6 (convergence math). §33 rule 12.
**Depends on:** M1 (Helius REST), M2 (`wallet` table). Powers change 3 (convergence).

## Why

Convergence scoring (§9, weight 20% memecoin) is meaningless without wallet dedup: five wallets
funded from the same source buying the same token is one signal, not five. Part II §5
explicitly says this "can't wait for a later milestone" — the interim heuristic must ship at
MVP. Full ML-based coordination detection is deferred; this change ships the plan's exact
interim heuristic (§5): first-hop SOL funder + optional secondary CEX-withdrawal grouping.

## What changes

`packages/watchlist` grows (or a new sibling `packages/clustering` — TBD in design):

- **`funder-fetch.ts`** — for a given wallet, fetch its **first-hop SOL funder** via Helius
  (the address that sent the wallet its first significant SOL). Cheap per-wallet call, cached
  in DB (a wallet's original funder never changes).
- **`funder-store.ts`** — persist funder relationships in a new `wallet_funder` table so we
  fetch once per wallet, then reuse forever.
- **`cluster.ts`** — pure: given a set of `(wallet, funder, funderTimestamp)` rows, group into
  clusters where wallets share a funder within a 24–72h window. Deterministic. Returns
  `Cluster[]`.
- **`recompute.ts`** — job that computes clusters over all rated wallets and stores them in a
  new `wallet_cluster` table (append-only, versioned by run — so a re-cluster doesn't corrupt
  live convergence lookups mid-flight).

Schema (migration 0005):
- `wallet_funder` — (`wallet_id`, `funder_address`, `funded_at`, `funded_sol`, `fetched_at`).
  Unique on `wallet_id` (one first-hop funder per wallet).
- `wallet_cluster` — (`cluster_id`, `wallet_id`, `cluster_run_id`, `clustered_at`). A cluster
  is the set of `wallet_id`s sharing a `cluster_id`.
- `cluster_run` — (`run_id` PK, `run_at`, `window_hours`, `wallet_count`, `cluster_count`).

## What this change does NOT do

- **No convergence signal** — that's change 3, which consumes these clusters.
- **No full ML coordination detection** (Part II §5, deferred). The interim heuristic is what
  MVP needs.
- **No secondary CEX-withdrawal heuristic in v1** (§5 mentions it as a follow-up "worth adding
  once the primary is working"). The design keeps this addable without a schema break.
- No auto-refresh on new wallets during change 3 — the clusters are recomputed on schedule (or
  on demand); a real-time incremental version is a later optimization.

## Resolved solo (flag)

- **Window = 48h** (middle of §5's stated 24–72h range) as MVP default. Lives in a small config
  constant, easily tuned.
- **"First significant SOL"** = the earliest inbound native transfer above a threshold
  (default 0.05 SOL, to skip dust/airdrops) — flagged so nobody assumes it's the literal first tx.
- Clustering runs on **rated wallets only** (§4 — unrated wallets carry no convergence weight
  anyway).
