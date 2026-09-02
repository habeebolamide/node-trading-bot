# Tasks: m6-predictions

## 1. Package
- [ ] `packages/predictions` (`@tip/predictions`) + references + alias + install

## 2. Schema (migration 0012)
- [ ] `prediction` — §19 fields; `config_version` NOT NULL FK; `unique(signal_id)`;
      `is_shadow` / `shadow_of` (§13, M7 populates)
- [ ] `prediction_outcome` — (prediction_id, horizon) PK; return/benchmark/alpha/MFE/MAE/
      hitTarget/hitInvalidation/holdingPeriod/won/`outcome_resolution`
- [ ] **raw-SQL trigger** blocking UPDATE/DELETE on `prediction` (rule 10) — hand-appended to the
      generated migration, called out in the PR because hand-edited migrations are unusual here
- [ ] `prediction_outcome` deliberately NOT locked — it accrues per horizon by design

## 3. Creation (`create.ts`)
- [ ] `createPrediction(db, input)` — one transaction: lock ACTIVE signal → insert → CONSUMED
- [ ] refuse EXPIRED / INVALIDATED / already-CONSUMED signals
- [ ] `features` captured from the signal's contributions (the §22 attribution input)

## 4. NO_TRADE handling
- [ ] extend `signal_risk` (or a sibling column) with `no_trade_reason` — a veto is recorded on
      the Signal, never as a Prediction with null entry/horizon
- [ ] document in-code that R:R-gate accuracy is not measurable until M7 shadow predictions

## 5. Reads
- [ ] `getPrediction`, `listPredictions({ agentId, domain, from, to, takenOnly })`
- [ ] no update/delete helpers exist at all — the API surface mirrors the DB guarantee

## 6. Tests
- [ ] trigger fires on UPDATE and on DELETE (live Postgres)
- [ ] configVersion required; bad FK rejected
- [ ] concurrent double-act on one signal → exactly one prediction (real concurrency, §29 pattern)
- [ ] EXPIRED / INVALIDATED signals refused
- [ ] signal reaches CONSUMED atomically with creation; rollback leaves neither
- [ ] shadow row creatable, `shadowOf` resolves

## 7. Wrap-up
- [ ] typecheck + full suite green
- [ ] ARCHIVE + completion summary
