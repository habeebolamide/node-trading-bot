# Tasks: m6-outcome-engine

## 1. Resolver (`packages/evaluation/src/outcome/`)
- [ ] `resolveOutcome({ prediction, horizon, data, mode })` → the §21 field set
- [ ] anchored at T1 (fill), never T0 — assert in code and test
- [ ] `mode: TICK | CANDLE_1M_CONSERVATIVE`; pessimistic SL-first tie-break in candle mode (§25)
- [ ] MFE/MAE signed by trade direction (correct for SHORT)

## 2. Benchmarks + alpha (Task 7)
- [ ] perp: underlying buy-and-hold over the window (+ BTC beta)
- [ ] memecoin: SOL return from `market_candle` SOLUSDT — M1 already stores it, no new provider
- [ ] `alpha = return − benchmark`

## 3. Horizon set (§8 + Task 7)
- [ ] the style's three horizons + the 1h cross-style reference
- [ ] planning horizon flagged — it is the one that feeds the Brain

## 4. Scheduled sweep
- [ ] find predictions with an elapsed, unresolved horizon → resolve → insert
- [ ] idempotent via `(prediction_id, horizon)` PK
- [ ] `brain_written_at` marker so the Brain write is at-most-once under concurrent sweeps

## 5. THE BRAIN WIRING (§41, §16) — M5's deferred call site
- [ ] on PLANNING-horizon resolution only:
      `recordSetupOutcome(db, { predictionId, domain, features, closedAt, won, returnPct })`
- [ ] `recordAgentOutcome(db, { predictionId, domain, closedAt, realizedDirection }, contributions)`
      with contributions read from `signal_feature` (M4 already persists them)
- [ ] `realizedDirection = sign(close(T1+h) − entry)`; flat tape breaks toward the non-benchmark side
- [ ] assert ONE occurrence per fingerprint per prediction — four horizons must not inflate
      effective-n 4×

## 6. Tests
- [ ] T1 anchoring with a late fill
- [ ] one prediction → one Brain occurrence, sweep run twice
- [ ] pessimistic tie-break in candle mode
- [ ] `outcomeResolution` present; live/seeded separable by query
- [ ] alpha ≈ 0 when the call merely matched its benchmark
- [ ] MFE/MAE for SHORT
- [ ] sweep idempotency
- [ ] **end-to-end**: Bybit fixture → … → BrainSetupMemory (CLAUDE.md's named integration test)

## 7. Wrap-up
- [ ] typecheck + full suite green
- [ ] ARCHIVE + completion summary noting that the Brain is now live-fed
