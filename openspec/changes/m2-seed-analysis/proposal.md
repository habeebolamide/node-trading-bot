# Change: m2-seed-analysis

**Status:** PROPOSED (scoping — awaiting review)
**Milestone:** M2 — Wallet Intelligence (§30), change 3 of 3
**Implements:** Part II §4 (the 100-wallet seed backfill + seed-history analysis pass that settles
four placeholder tunables), §11 (manual wallet seeding, MVP). CLAUDE.md "Placeholders" table.

**Depends on:** m2-trade-reconstruction + m2-wallet-scoring.
**Input required from you:** the roster of ~100 seed wallet addresses (a file, e.g.
`scripts/seed/wallets.txt`, one address per line). Manual seeding is the MVP path (§11); automated
discovery is M3.

## Why

CLAUDE.md: "M2's first task is the 100-wallet seed backfill + the seed-history analysis pass (Part
II §4). That analysis is what settles four placeholder defaults." The MVP currently hard-codes
guesses; this change measures them from the seeded wallets' real history so the memecoin live path
launches on data, not round numbers.

## What changes

- **Seed run**: backfill + reconstruct + score every seed wallet (reusing changes 1 & 2) → a
  populated, scored wallet universe on day one.
- **Analysis pass** (`packages/wallets/analysis/` + a `scripts/seed-analysis.ts` runner) measuring,
  from the seed history + observed-swap price series:
  1. **`batchingWindowMs`** — distribution of `last_buy − first_buy` across co-buys of 3+ seed
     wallets on the same token; recommend a percentile (80th/90th) that captures the bulk without
     burning the tight TTL.
  2. **`walletExitThreshold`** — how often a partial cluster-sell precedes a full dump vs. resolves
     as a false alarm.
  3. **`profitLadder` rungs** — of co-buy events that reached ≥2×, what fraction reached 3× / 5× /
     10× (post-entry max from the observed-swap series) → where the rungs should sit.
  4. **freshness `τ`** — how fast the co-buy edge (forward return) decays with entry delay.
- **Output**: `docs/research/seed-history-analysis.md` — the measured distributions, the
  recommended value for each tunable, and the sample sizes behind them.

## Important scoping notes

- **The tunables' config homes don't exist in code yet** (`ScoringConfig` / the memecoin freshness
  feature are M4+). So this change's deliverable is the **research doc + recommended values**; the
  numbers get wired into config when those subsystems land (the plan's "feeds concrete numbers into
  all four before the live path is built"). Each recommended value carries a code comment pointer
  back to this doc when it's eventually set (CLAUDE.md Placeholders rule).
- **Co-buy grouping here is analysis-only, NOT the production convergence path.** Funder-cluster
  dedup (§5) is M3. The analysis uses a naive same-token, same-time-window grouping of seed-wallet
  buys — good enough to characterize the distributions, explicitly not the real convergence
  detector. Flagged so nobody mistakes it for M3's clustering.
- Reproducible: the analysis reads only local Postgres (the seeded history), so re-running gives
  the same numbers (§25 discipline), and it can be re-run as the seed roster grows.

## What this change does NOT do

- No production convergence detection / funder clustering (M3).
- No automated wallet discovery (M3).
- No wiring of the tuned values into a live config (the config homes are M4+; this records them).
