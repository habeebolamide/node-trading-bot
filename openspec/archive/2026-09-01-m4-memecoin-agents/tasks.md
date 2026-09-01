# Tasks: m4-memecoin-agents

`[x]` done

## 1. Package
- [x] `packages/agents` (`@tip/agents`) + tsconfig + root ref + vitest alias

## 2. Common infrastructure
- [x] `common/trigger-router.ts` — routes DomainEvents to matching AnalysisAgents; sink pattern;
      double-register guard; skipped-output filter
- [x] `common/token-candle.ts` — on-demand OHLCV per (mint, timeframe) from wallet_transaction;
      pure aggregation

## 3. Memecoin agents (5) + hard veto
- [x] `memecoin/smart-money.ts` (§40.7) — normalizes walletScore, size-weighted confidence
- [x] `memecoin/convergence.ts` (§40.8) — packages M3 emitter payload; independent-cluster
      count + timeCompression drive confidence
- [x] `memecoin/momentum.ts` (§40.9) — CADENCE + CONDITIONAL; slope + vol-ratio + extension
      penalty; dead-candle skip; insufficient-history cap
- [x] `memecoin/token-quality.ts` (§40.10) — unipolar; missing-sub-feature caps confidence at 0.6
- [x] `memecoin/market-regime.ts` (§40.11) — reads SOL kline history from market_candle; enum
      {BULL, BEAR, RANGE, HIGH_VOL, LOW_CONFIDENCE} + directional bias
- [x] `memecoin/token-risk.ts` (§40.13 hard veto) — 5 checks + fail-closed on missing metadata;
      `isVetoed` helper

## 4. Features (aggregator-only, no trigger)
- [x] `memecoin/features/early-entry.ts` (§40.17) — reads BrainWalletMemory.earlyEntry, aggregates
      per-wallet peak forward-return weighted by score × amountSol × coverage
- [x] `memecoin/features/freshness.ts` (§40.18) — `exp(-Δt/τ)`, τ=15s default

## 5. Registration
- [x] `memecoin/index.ts` — exports memecoinAgents (the 5 composite-participating agents) +
      Token Risk separately (hard veto, not composite) + features

## 6. Tests
- [x] unit: 5 agents + Token Risk (17 tests covering happy paths + edge cases + all 5 veto
      conditions + fail-closed)
- [x] unit: TriggerRouter (3) — dispatch, dedup guard, skipped-filter
- [x] unit: freshness τ + early-entry no-data (in agents.test.ts)

## 7. Wrap-up
- [x] typecheck + full suite green (201/204 tests pass, 3 opt-in live skipped)
- [x] ARCHIVE + summary
