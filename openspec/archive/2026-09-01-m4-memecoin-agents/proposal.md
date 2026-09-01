# Change: m4-memecoin-agents

> **COMPLETED 2026-09-01.** Shipped `packages/agents` with the 5 memecoin composite-agents +
> Token Risk hard veto + 2 features:
> - `common/trigger-router.ts` (dispatch DomainEvents → matching AnalysisAgents; sink pattern)
> - `common/token-candle.ts` (per-mint OHLCV on demand from wallet_transaction)
> - `memecoin/smart-money.ts` (§40.7 — walletScore normalization + size-weighted confidence)
> - `memecoin/convergence.ts` (§40.8 — packages M3 emitter output; cluster-count + timeCompression → confidence)
> - `memecoin/momentum.ts` (§40.9 — slope + volume ratio + extension penalty; CONDITIONAL dead-candle skip)
> - `memecoin/token-quality.ts` (§40.10 — unipolar; missing sub-feature caps confidence at 0.6)
> - `memecoin/market-regime.ts` (§40.11 — SOL kline history → BULL/BEAR/RANGE/HIGH_VOL + bias)
> - `memecoin/token-risk.ts` (§40.13 hard veto — 5 checks + fail-closed; `isVetoed` helper)
> - `memecoin/features/early-entry.ts` (§40.17 — reads BrainWalletMemory.earlyEntry, coverage-weighted)
> - `memecoin/features/freshness.ts` (§40.18 — `exp(-Δt/τ)`, τ=15s default)
>
> `memecoinAgents` array holds the 5 composite participants; Token Risk exported separately
> because it's a hard veto, not a composite input.
>
> **Verified:** typecheck green; **201/204 tests pass** (3 opt-in live). 20 new tests: 17
> covering all 5 agents + Token Risk (including every §40.13 veto condition + fail-closed on
> missing metadata) + 3 TriggerRouter (dispatch, dedup guard, skipped-filter).
>
> **Deviations from spec:** none material. `token-candle.ts` invalidates via re-query (no
> caching yet — MVP scale). Market Regime uses simplified ATR/slope thresholds instead of full
> ADX; the deeper implementation lands with the perp variant in change 4. Next: m4-perp-agents.

**Status:** COMPLETED — archived
**Original status:** PROPOSED (scoping)
**Milestone:** M4 — Agent Swarm (§30), change 3 of 5
**Implements:** §40.7 Smart Money, §40.8 Convergence, §40.9 Momentum, §40.10 Token Quality,
§40.11 Market Regime, §40.13 Token Risk (hard veto), §40.17 Early-Entry Edge feature,
§40.18 Signal Freshness feature. Part II §9 (composite). §33 rules 13, 17, 23.
**Depends on:** m4-tradingagent, m4-signal-engine, m3-convergence (Convergence Agent consumes
its events), m3-watchlist (Smart Money Agent uses walletScoreAsOf).

## Why

Ships the **memecoin agent roster** — the actual specialized reasoners that turn wallet
activity and market data into per-agent `{score, confidence, features}` outputs the Signal
Engine (change 2) composes. Once these land, `POST /trading-agents` for a memecoin agent
produces real signals on live convergence events.

## What changes

New package **`packages/agents`** (grows in change 4 for perp):

- **`memecoin/smart-money.ts`** — §40.7 EVENT trigger on `memecoin.wallet.buy.detected`;
  weighted average of buying wallet scores (via `walletScoreAsOf`); normalizes vs universe
  median → [0, +1] (long-only).
- **`memecoin/convergence.ts`** — §40.8 EVENT trigger on `memecoin.wallet.convergence.detected`
  (from M3 change 3); reads `perCluster`/`independentClusterCount`; produces
  `convergence_score = Σ (clusterQuality × independenceWeight) × timeCompression` (same math
  m3-convergence already runs — the agent just packages it as `{score, confidence, features}`).
- **`memecoin/momentum.ts`** — §40.9 CADENCE+CONDITIONAL on token candle close; volume
  acceleration + price slope + extension penalty (token OHLCV built from Helius swaps).
- **`memecoin/token-quality.ts`** — §40.10 EVENT on `token.profile.updated`; liquidity + age
  + holder concentration → [0, +1].
- **`memecoin/market-regime.ts`** — §40.11 CADENCE on SOL kline close; enum
  `{BULL, BEAR, RANGE, HIGH_VOL}` + directional bias.
- **`memecoin/token-risk.ts`** — §40.13 HARD VETO: mint authority live, freeze authority
  present, LP unlocked, top-holder > 40%, honeypot patterns. Fires on
  `token.activity.detected` / `token.profile.updated`. On veto: emits `token.risk.vetoed`,
  signal never enters the composite.
- **`memecoin/features/early-entry.ts`** — §40.17: per triggering wallet, aggregate historical
  peak forward-return via `BrainWalletMemory.earlyEntry` (populated by M2 change 2 already).
- **`memecoin/features/freshness.ts`** — §40.18: `exp(−Δt/τ)`, τ=15s default (§9a placeholder).

Aggregate token-candle infrastructure: a small `token-candle.ts` module builds token OHLCV
from persisted `wallet_transaction` swaps for whichever mints TradingAgents are watching.

## What this change does NOT do

- **No perp agents** (change 4).
- **No Risk Agent** (post-aggregation veto — change 5).
- **No LLM Judge** — memecoin has near-zero surface for Judge FLIP (§18 memecoin note); M7 in scope.
- Historical Edge (§40.19) not built — needs BrainSetupMemory (M5).
- No Paper Engine — M6.

## Resolved solo (flag)

- **Token OHLCV window default = 1h.** Actual per-agent timeframe comes from the TradingAgent's
  `tradingStyle` (§8). At M4 we only aggregate on demand for watched mints.
- **`walletExitThreshold` accumulator, profit ladder, wallet-exit event** are Paper Engine
  concerns (Part II §10) → deferred to M6. Agents just produce signals.
