# Design: m4-memecoin-agents

Read §40.7–§40.11, §40.13, §40.17, §40.18, Part II §9 alongside.

## Package layout

```
packages/agents/
  common/
    trigger-router.ts      routes DomainEvents to the right agents by trigger type
    token-candle.ts        aggregate wallet_transaction swaps into per-mint OHLCV on demand
  memecoin/
    smart-money.ts
    convergence.ts
    momentum.ts
    token-quality.ts
    market-regime.ts
    token-risk.ts
    features/
      early-entry.ts
      freshness.ts
    index.ts               registers all 5 agents + Token Risk + features
```

Each agent implements `AnalysisAgent` (change 1's interface).

## Individual agent notes

**smart-money** (§40.7) — EVENT on `memecoin.wallet.buy.detected` (from m3-watchlist):
`walletScoreAsOf(wallet, blockTime)` (rule 21) → normalize to [0,1] vs universe median.
Direction always `LONG` (long-only). Confidence f(total_usd, wallet_count).

**convergence** (§40.8) — EVENT on `memecoin.wallet.convergence.detected` (from m3-convergence):
consumes `perCluster`/`independentClusterCount`/`convergenceScore` from the payload; packages
as `{ score = min(convergenceScore/max, 1), confidence f(independentClusters, timeCompression) }`.

**momentum** (§40.9) — CADENCE+CONDITIONAL on token-candle close (built via
`common/token-candle.ts` from persisted `wallet_transaction` at the TradingAgent's primary TF):
`0.5 · slope_normalized + 0.5 · min(vol_ratio/3, 1) × extension_penalty`. Dead-candle skip.

**token-quality** (§40.10) — EVENT on `token.profile.updated`: liquidity + age + holder
concentration via Helius. Unipolar (LONG or 0, never negative). `confidence` degrades if any
sub-feature missing.

**market-regime** (§40.11) — CADENCE on SOL kline close (Bybit SOLUSDT): identical mechanics
to perp Market Regime (§40.3) but on SOL. Broadcasts `memecoin.regime.classified`.

**token-risk** (§40.13, HARD VETO) — EVENT on `token.activity.detected` /
`token.profile.updated`: boolean checks per §40.13 (mint authority, freeze, LP status,
top-holder, honeypot). ANY TRUE → publish `token.risk.vetoed` + short-circuit downstream
(the aggregator drops signals for vetoed mints). Fail-closed on Helius error.

**features/early-entry.ts** (§40.17) — aggregator-only. Reads `BrainWalletMemory.earlyEntry`
(populated by M2 change 2), aggregates per triggering wallet weighted by score × USD.
Coverage-aware down-weighting.

**features/freshness.ts** (§40.18) — aggregator-only. `exp(−Δt/τ)`, τ=15s.

## Token OHLCV (`common/token-candle.ts`)

Per-mint on-demand aggregation from `wallet_transaction`:

```
buildTokenCandles(db, mint, timeframe, sinceMs?, untilMs?)
  → group swaps into buckets of `timeframe`
  → OHLCV computed from price = amountSol/tokenAmount, volume = Σ amountSol
  → returns Candle[]  (cached in-memory per-mint per-tf, invalidated on new swap ingest)
```

At M4 only used by Momentum. Cached rolling for watched mints so agents don't hit the DB on
every trigger.

## Trigger routing (`common/trigger-router.ts`)

The framework built in change 2 supplies aggregator + signal-engine. Change 3 wires triggers:

```
router.on(EVENT_NAMES.MEMECOIN_WALLET_BUY_DETECTED, smartMoneyAgent, convergenceAgent);
router.on(EVENT_NAMES.MEMECOIN_WALLET_CONVERGENCE_DETECTED, convergenceAgent);
router.on(EVENT_NAMES.TOKEN_ACTIVITY_DETECTED, tokenRiskAgent);
router.on(EVENT_NAMES.TOKEN_PROFILE_UPDATED, tokenQualityAgent, tokenRiskAgent);
router.onCandleClose('SOL', memecoinRegime);
router.onTokenCandleClose(momentum);
```

Each agent that canHandle → produces AgentOutput → published as `agent.analysis.completed` →
aggregator picks it up.

## Testing

Unit (fixture inputs, no live network):
- smart-money: weighted-avg, universe-normalize, unrated wallets excluded
- convergence: reads payload correctly, thin-single-cluster → low confidence
- momentum: volume acceleration + slope, dead-candle skip, insufficient-history cap
- token-quality: three-feature weighted, missing sub-feature caps confidence
- token-risk: each veto condition → veto (5 tests), all clean → no veto
- early-entry / freshness: null-on-gap, τ default

Integration (live DB):
- End-to-end: seed a MEMECOIN_WALLET_BUY_DETECTED event → smart-money + convergence outputs
  appear → aggregator flushes → signal row created via change 2's pipeline

Live smoke (documented, not automated): a real Helius webhook delivery through the whole chain.
