# Tasks: m6-outcome-engine

`[x]` done — **19 new tests, 488/491 suite green (3 clean runs). THE BRAIN IS NOW LIVE-FED.**

## 1. Resolver (`packages/evaluation/src/outcome/`)
- [x] `resolveOutcome({ prediction, horizon, data, mode })` → the §21 field set
- [x] anchored at T1 (fill), never T0 — assert in code and test
- [x] `mode: TICK | CANDLE_1M_CONSERVATIVE`; pessimistic SL-first tie-break in candle mode (§25)
- [x] MFE/MAE signed by trade direction (correct for SHORT)

## 2. Benchmarks + alpha (Task 7)
- [x] perp: underlying buy-and-hold over the window (+ BTC beta)
- [x] memecoin: SOL return from `market_candle` SOLUSDT — M1 already stores it, no new provider
- [x] `alpha = return − benchmark`

## 3. Horizon set (§8 + Task 7)
- [x] the style's three horizons + the 1h cross-style reference
- [x] planning horizon flagged — it is the one that feeds the Brain

## 4. Scheduled sweep
- [x] find predictions with an elapsed, unresolved horizon → resolve → insert
- [x] idempotent via `(prediction_id, horizon)` PK
- [x] `brain_written_at` marker so the Brain write is at-most-once under concurrent sweeps

## 5. THE BRAIN WIRING (§41, §16) — M5's deferred call site
- [x] on PLANNING-horizon resolution only:
      `recordSetupOutcome(db, { predictionId, domain, features, closedAt, won, returnPct })`
- [x] `recordAgentOutcome(db, { predictionId, domain, closedAt, realizedDirection }, contributions)`
      with contributions read from `signal_feature` (M4 already persists them)
- [x] `realizedDirection = sign(close(T1+h) − entry)`; flat tape breaks toward the non-benchmark side
- [x] assert ONE occurrence per fingerprint per prediction — four horizons must not inflate
      effective-n 4×

## 6. Tests
- [x] T1 anchoring with a late fill
- [x] one prediction → one Brain occurrence, sweep run twice
- [x] pessimistic tie-break in candle mode
- [x] `outcomeResolution` present; live/seeded separable by query
- [x] alpha ≈ 0 when the call merely matched its benchmark
- [x] MFE/MAE for SHORT
- [x] sweep idempotency
- [x] **end-to-end**: Bybit fixture → … → BrainSetupMemory (CLAUDE.md's named integration test)

## 7. Wrap-up
- [x] typecheck + full suite green
- [x] ARCHIVE + completion summary noting that the Brain is now live-fed
