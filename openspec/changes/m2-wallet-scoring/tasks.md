# Tasks: m2-wallet-scoring

`[ ]` todo · `[x]` done  (SCOPING — not yet started; depends on m2-trade-reconstruction)

## 1. Schema (migration 0003)
- [ ] `wallet` (address PK, firstSeenAt, lastScoredAt, tradeCount, status rated|unrated)
- [ ] `wallet_score_event` (append-only: id, walletId, timestamp, score, configVersion,
      inputsUsed jsonb; index (walletId, timestamp))
- [ ] `brain_wallet_memory` (walletId PK, earlyEntry jsonb, behavioral stats, updatedAt)
- [ ] `wallet_scoring_config` (version PK, weights, priors, thresholds, createdAt, active)
- [ ] `trade_outcome` (per closed trade: forward returns per horizon, realized, coverage)

## 2. Metrics + scoring
- [ ] `price-series.ts` — sparse per-token series from swaps + forwardReturns (null-on-gap)
- [ ] `early-entry.ts` — per-wallet aggregate + coverage → BrainWalletMemory
- [ ] `shrinkage.ts` — Beta-Binomial shrunk rate
- [ ] `metrics.ts` — 7 sub-metrics (confirm build-time formulas from design)
- [ ] `scoring.ts` — percentile normalize + weighted composite + UNRATED gate
- [ ] `score-log.ts` — append WalletScoreEvent; walletScoreAsOf (NO currentScore in replay path)
- [ ] `recompute.ts` — 25-trades / daily trigger; emit wallet.score.updated / profile.updated
- [ ] seed a default `wallet_scoring_config` row (the §4 weights)

## 3. Tests (mandatory)
- [ ] shrinkage: 2/2 < 350/500; n=0→base; monotonic
- [ ] percentile: weights sum, boundaries, single-wallet universe
- [ ] walletScoreAsOf: never returns timestamp>T; correct latest≤T; n<10 → UNRATED
- [ ] early-entry: null horizons stay null, coverage correct, peak correct
- [ ] integration (live DB): recompute seeded wallet → one event appended + as-of reads it

## 4. Wrap-up
- [ ] typecheck + test green; ARCHIVE + summary

## Sign-off asks
- Confirm `WalletScoringConfig` as a domain-level versioned config, separate from ScoringConfig.
- Confirm the MVP sub-metric formulas (Consistency / Specialization / Trade Quality / Corroboration).
