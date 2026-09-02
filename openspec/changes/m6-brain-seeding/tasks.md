# Tasks: m6-brain-seeding

## 0. PREREQUISITE (operational — human, not code)
- [ ] Run the M1 backfill at scale: **≥ 6 months** of 1m/5m/15m/1h/4h/1d klines + funding + OI for
      BTC, ETH, SOL. CLAUDE.md's M1 exit criterion; built at M1 but only smoke-tested so far.
      `npm run backfill --workspace @tip/scripts -- --months=6 ...`
- [ ] Verify row counts + contiguity (gap detection) before seeding — a gapped range produces a
      quietly wrong Brain

## 1. 1m resolution (`evaluation/src/outcome/resolve-1m.ts`)
- [ ] scan 1m bars T1 → T1+horizon; SL-only / TP-only / neither
- [ ] **ambiguous bar (spans both) → SL FIRST** (§25 pessimistic tie-break)
- [ ] MFE/MAE from bar extremes; resolve at horizon close if neither level touched
- [ ] `outcomeResolution = CANDLE_1M_CONSERVATIVE` on every row

## 2. Seeding runner (`evaluation/src/seed.ts`)
- [ ] drive `ReplayEngine` over the backfilled range per symbol
- [ ] at each step: perp agents → SignalEngine → planTrade → createPrediction (NOT isShadow)
- [ ] resolve via 1m; write outcomes; call `recordSetupOutcome` + `recordAgentOutcome`
- [ ] checkpoint per (symbol, cursor) for resumability; idempotent by the occurrence unique key
- [ ] **refuse `domain: 'memecoin'` outright** (§25 scope) — throw, never partially seed

## 3. CLI (`scripts/seed-brain.ts`)
- [ ] `--symbols --from --to --style --agent` + `--dry-run` (report without writing)
- [ ] progress logging via the file logger

## 4. Gate report (§30 / §32)
- [ ] fingerprints encountered · fingerprints at effective-n ≥ 10 · occurrences written ·
      seeded win rate overall and by regime · range · symbols · configVersion
- [ ] REPORTED, not asserted — the human decides the launch bar
- [ ] log a prominent caution that an implausibly high seeded win rate indicates look-ahead,
      not edge

## 5. Tests
- [ ] pessimistic tie-break reached and applied on a constructed spanning bar
- [ ] `CANDLE_1M_CONSERVATIVE` on every seeded row; separable from live rows by query
- [ ] seeded occurrences carry TRUE historical dates and decay accordingly at a later `asOf`
- [ ] **determinism**: same range twice → byte-identical Setup Memory rows
- [ ] resumability: interrupted run == uninterrupted run
- [ ] idempotency: re-seeding a completed range writes zero new occurrences
- [ ] no look-ahead: adding post-T data does not change a prediction at T
- [ ] memecoin seeding throws

## 6. Wrap-up
- [ ] typecheck + full suite green
- [ ] ARCHIVE + completion summary INCLUDING the gate numbers from a real run
- [ ] **M6 COMPLETE** — note what M7 (Judge, §24 hypothesis pipeline) picks up
