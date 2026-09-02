# Change: m5-wallet-token-memory

> **COMPLETED 2026-09-02.**
> - `wallet-memory.ts` — behavioral profile (median hold, avg position, trades/day,
>   specialization, cluster affiliations) on a 60d half-life (Task 6 wallet metric, distinct from
>   the 30d/90d setup half-lives). Unrated below effective-n 10, with thin aggregates still
>   returned for inspection rather than hidden. OPEN positions excluded — a wallet must not look
>   disciplined by never selling. Recomputed per `asOf`, never served from the cached column.
> - `token-memory.ts` — Task 6 inputs (liquidity / age / holder-concentration / volume),
>   percentile-normalized, holder concentration INVERTED. Null score when no sub-metric is
>   available or the universe is thinner than 10 peers — never a fabricated percentile. Safety is
>   absent by design; Token Risk (§40.13) stays the hard gate.
> - `market-memory.ts` — a QUERY over Setup Memory grouped by the regime dimension, not a table
>   (§8: regime already hashes into the fingerprint, so the split falls out for free).
> - `brain.ts` — `createBrain(db, domain)` facade, one per domain (§15). Memecoin-only methods
>   THROW on a perp Brain rather than returning null: that call is a bug, not an empty result.
>
> Migration 0010: `brain_wallet_memory.behavior`, `brain_token_memory`.
>
> **Verified:** typecheck green; **377/380 tests pass** (3 opt-in live), 41 new — token score
> (14), regime partitioning (10), wallet memory live-DB (10), Brain facade live-DB (7).
>
> **`asOf` is now enforced at COMPILE TIME.** CLAUDE.md asks for the no-look-ahead rule to be
> "structural, not by convention," so `brain.ts` carries a conditional-type guard that fails
> `tsc --build` if any Brain read stops requiring `asOf`. Verified by temporarily loosening a
> signature and confirming the build breaks with `Type 'true' is not assignable to type 'false'`.
>
> **Two test-design findings from running the full suite** (both real properties, not flaky
> tests):
> 1. `setup()` on an unknown fingerprint no longer scores exactly 0 once the domain's global rung
>    has history — it correctly falls back to the global base rate at 0.5^5 attenuation. The
>    earlier assertion only held on a virgin database.
> 2. Market Memory is domain-global by construction, and vitest runs test files in parallel
>    against one database, so before/after deltas cannot be asserted as equalities. The invariant
>    that actually matters — every setup lands in exactly one regime bucket — is now proved as a
>    pure property of the id sets (disjoint, and together covering all 243 / 6,561 cells), where
>    concurrency cannot reach it.

**Status:** COMPLETED — archived
**Original status:** PROPOSED (scoping)
**Milestone:** M5 — Brain (change 3 of 4)
**Implements:** §15 shared-domain Brain · §16 Market Memory · Part II §8 Wallet Memory + Token
Memory · Part II §6 Token Intelligence · Task 6 (§34) token score formula · §13 entity list
(`BrainTokenMemory`) · §33 rules 8, 21, 23

## What's changing

The two memecoin-domain Brain memories that M2/M3 left partially built, plus the shared
Market Memory read.

1. **Wallet Memory** (`brain_wallet_memory` — table exists, holds only `earlyEntry` from M2).
   Adds the behavioral profile Part II §8 calls for: per-wallet aggregate hold-time, average
   position size, token-category specialization, and cluster affiliation history — all
   recency-weighted (60d half-life, Task 6) and all read through a **point-in-time** interface.
2. **Token Memory** (`brain_token_memory` — new). Part II §8 "historical token/setup behavior":
   per-mint aggregate of how tokens with this profile have behaved — liquidity/age/holder
   concentration at signal time vs realized forward returns. Task 6's token score formula
   (liquidity / age / holder-concentration / volume, percentile-normalized) becomes a Brain
   read instead of a per-signal recomputation.
3. **Market Memory** (§16) — "how setups behave under different market regimes." A thin read
   over Setup Memory grouped by the regime dimension, exposed per domain. Deliberately not a
   new table: regime is already a fingerprint dimension (Part II §8 "Regime requires no
   separate handling"), so Market Memory is a *query*, not a store.
4. **Brain read facade** (`packages/brain/src/index.ts`) — one `Brain` per domain exposing
   `wallet`, `token`, `setup`, `market`, `agent` (change 4) reads, all `asOf`-parameterized.
   This is the object §15 describes and the Judge (M7) will be handed.

## Why this ordering

Changes 1 and 2 build the statistical machinery every memory shares. This change is mostly
*aggregation and interface*, and its two consumers — the memecoin composite and M7's Judge
evidence package — both need the facade rather than the individual tables.

## What this change does NOT do

- **Does not recompute wallet scores.** `WalletScoreEvent` + `scoreAllWallets` (M2) already own
  that, append-only and point-in-time (rule 21). Wallet Memory is the *behavioral profile*
  alongside the score, not a second scoring path. Explicitly no `currentWalletScore()` is added
  or exposed.
- **Does not add a token price API.** M2's resolved decision — Early-Entry Edge uses the
  observed-swap price approximation — stands. Token Memory reads what `trade_outcome` already
  records; where a horizon has no observed swap it stays null and lowers `coverage`. Never
  fabricated (rule 25's spirit).
- **Does not build memecoin autopsy** (§24, deferred until memecoin has a backtest) or seed the
  memecoin Brain (§25 scopes memecoin out of seeding entirely — it warms up from live paper
  trading only).

## Ambiguity resolved (needs sign-off)

**Part II §8 defines Wallet Memory and Token Memory in one line each** ("Historical wallet
behavior" / "Historical token/setup behavior") with no field list — this is one of the
"deferred to build time" areas CLAUDE.md names. Field lists are derived in `design.md` from
Part II §2 (Wallet Intelligence), §6 (Token Intelligence) and Task 6's token score formula,
which together pin down what these memories must answer.
