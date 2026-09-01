# Tasks: m2-wallet-scoring

`[x]` done  (depends on m2-trade-reconstruction — done)

## 1. Schema (migration 0003) — applied
- [x] `wallet`, `wallet_score_event` (append-only, indexed), `brain_wallet_memory`,
      `wallet_scoring_config` (versioned), `trade_outcome`

## 2. Metrics + scoring
- [x] `stats.ts` — Beta-Binomial shrinkage, percentileRank, median/mean/stddev
- [x] `price-series.ts` — sparse per-token series from swaps + forwardReturns (null-on-gap, coverage, peak)
- [x] `early-entry.ts` — per-wallet aggregate over observed swaps → trade_outcome + BrainWalletMemory
- [x] `metrics.ts` — 7 sub-metrics (shrunk win rate; coverage-down-weighted early-entry; MVP
      formulas for consistency/specialization/trade-quality; corroboration passed in)
- [x] `scoring.ts` — percentile-normalize across universe + weighted composite (renormalized)
- [x] `score-log.ts` — appendWalletScore; walletScoreAsOf(T) (NO currentScore); liveWalletScore
- [x] `config.ts` — loadActiveWalletScoringConfig; seeds §4 default weights as version 1
- [x] `recompute.ts` — `scoreAllWallets` full pass (universe percentiles, UNRATED gate,
      corroboration co-occurrence, appends events, upserts profiles + BrainWalletMemory, emits events)

## 3. Tests (mandatory)
- [x] shrinkage: 2/2 < 350/500; n=0→base; monotonic
- [x] percentile: max→100, boundaries, single-wallet, empty→neutral
- [x] price-series/forwardReturns: null horizons stay null, coverage, peak, entryPrice≤0 guard
- [x] scoring: percentile ordering, weight renormalization, single-wallet→100, empty
- [x] integration (live DB): 12-trade wallet RATED + scored, 3-trade wallet UNRATED (no event);
      walletScoreAsOf never returns the future; profiles reflect status

## 4. Wrap-up
- [x] typecheck + full suite green (95 pass, 3 opt-in skipped)
- [x] ARCHIVE → `openspec/archive/2026-09-01-m2-wallet-scoring/` + summary

## Sign-off (confirmed by user at scoping)
- [x] WalletScoringConfig = domain-level versioned config, separate from ScoringConfig
- [x] MVP sub-metric formulas (Consistency / Specialization / Trade Quality / Corroboration)
