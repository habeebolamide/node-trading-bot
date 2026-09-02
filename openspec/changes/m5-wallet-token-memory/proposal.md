# Change: m5-wallet-token-memory

**Status:** PROPOSED (scoping)
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
