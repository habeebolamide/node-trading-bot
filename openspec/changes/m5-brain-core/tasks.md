# Tasks: m5-brain-core

## 1. Package scaffold
- [ ] `packages/brain` — package.json (`@tip/brain`), tsconfig (extends base, references
      `@tip/database` + `@tip/domain`), src/index.ts
- [ ] Root tsconfig.json project reference + vitest.config.ts alias

## 2. Schema (migration 0009)
- [ ] `brain_setup_occurrence` — (id PK, setup_id, prediction_id, domain, closed_at, won,
      return_pct); `unique(prediction_id)` for rule-12 idempotency; index on (setup_id)
- [ ] `brain_setup_memory` — (setup_id PK, domain, effective_n, effective_wins, win_rate,
      median_return, wilson_lower, wilson_upper, evidence, occurrence_count, last_updated_at)
- [ ] `brain_token_memory` placeholder deferred to change 3 — do NOT add here
- [ ] generate + apply migration

## 3. Statistics (`packages/brain/src/stats.ts`) — §41 verbatim math
- [ ] `confidenceToZ(confidence)` — {0.90, 0.95, 0.99} lookup, throws on anything else
- [ ] `wilsonInterval(effectiveWins, effectiveN, confidence = 0.95)` — fractional-n safe;
      `effectiveN <= 0` → `{ lower: 0, upper: 1, center: 0.5 }`; clamps to [0,1]
- [ ] `weightedMedian(items)` — null on empty / zero total weight
- [ ] `recencyWeight(ageDays, halflifeDays)` = `0.5 ** (ageDays / halflifeDays)`

## 4. Fingerprint (`packages/brain/src/fingerprint.ts`) — Part II §8, rule 24
- [ ] `bucket(x)` → LOW | MED | HIGH at fixed cut-points ∓1/3 (boundaries land MED)
- [ ] `MEMECOIN_DIMENSIONS` (5, canonical order) / `PERP_DIMENSIONS` (8, canonical order)
- [ ] `setupFingerprint(domain, features)` — sha256 over `domain|name:bucket|…` in canonical
      dimension order; 32-hex-char prefix. Throws ValidationError on a missing dimension —
      never silently fingerprints a partial tuple (rule 24)
- [ ] docstring cross-referencing `@tip/trading-agents` `signalFingerprint` so the two are
      never confused

## 5. Setup memory write path (`packages/brain/src/setup-memory.ts`) — §41
- [ ] `TradeOutcome` type (predictionId, setupId, domain, closedAt, won, returnPct)
- [ ] `HALFLIFE_DAYS = { perp: 90, memecoin: 30 }` + `TRUST_THRESHOLD_EFFECTIVE_N = 10`,
      each with a comment naming the Task-6 / §8 resolution it comes from
- [ ] `updateSetupMemory(db, outcome)` — insert occurrence (onConflictDoNothing on
      prediction_id), recompute aggregates over all occurrences with `now = outcome.closedAt`,
      upsert `brain_setup_memory`. Write-side does NOT back off (§41 implementer note)
- [ ] `readSetupMemory(db, setupId)` — exact-fingerprint read only; backoff is change 2

## 6. Tests
- [ ] `stats.test.ts` — wilsonInterval (n=0, n<10, n=10, all-wins, all-losses, fractional n,
      bad confidence throws), weightedMedian (empty, zero-weight, single, skewed),
      recencyWeight (age 0 → 1, age = halflife → exactly 0.5, age = 2×halflife → 0.25)
- [ ] `fingerprint.test.ts` — determinism, order-independence, boundary values → MED,
      243 distinct memecoin ids over the full bucket space, 6,561 distinct perp ids,
      missing dimension throws
- [ ] `setup-memory.integration.test.ts` (live DB) — first close creates row; decay across a
      half-life boundary; all-simultaneous equals unweighted; INSUFFICIENT → SUFFICIENT at
      effective-n 10 with Wilson appearing only then; replaying the same prediction_id is a
      no-op
- [ ] typecheck + full suite green

## 7. Wrap-up
- [ ] ARCHIVE to `openspec/archive/<date>-m5-brain-core/` + completion summary
