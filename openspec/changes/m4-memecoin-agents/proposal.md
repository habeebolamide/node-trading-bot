# Change: m4-memecoin-agents

**Status:** PROPOSED (scoping)
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
