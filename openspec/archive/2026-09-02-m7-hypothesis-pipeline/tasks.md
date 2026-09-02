# Tasks: m7-hypothesis-pipeline

`[x]` done — **23 new tests, 607/610 suite green (3 clean runs). M7 COMPLETE.**

## 1. Schema (migration 0019)
- [x] `learning_hypothesis` — full field list per design.md, index (status, setup_id)

## 2. Aggregation (`packages/evaluation/src/hypothesis/aggregate.ts`)
- [x] `aggregatePatterns(db, {domain, asOf})` — recency-weighted effective-n per
      (setupId, category, categoryKind) using @tip/brain helpers
- [x] refuses to yield below effective-n ≥ 20 (§24)

## 3. Proposal (`packages/evaluation/src/hypothesis/propose.ts`)
- [x] `CATEGORY_TO_ADJUSTMENT_V1` — deterministic table
- [x] `proposeFromPattern(pattern)` → LearningHypothesis row shape | null

## 4. Backtest + OOS (`packages/evaluation/src/hypothesis/backtest.ts`)
- [x] `runBacktest` — reuses walkForwardFolds + evaluateFold
- [x] `runOutOfSample` — held-out later window, disjoint by construction
- [x] `isImprovement` — accuracy + meanAlpha both up, non-overlapping Wilson (§M6c5)

## 5. Promotion (`packages/evaluation/src/hypothesis/promote.ts`)
- [x] `promoteHypothesis` — reads current config, applies delta, inserts NEW scoring_config row
- [x] never touches old config rows (rule 16)

## 6. Bootstrap gate
- [x] `isBootstrapping` blocks PROMOTED; status becomes DEFERRED_BOOTSTRAP; re-runnable

## 7. Tests
- [x] pure: aggregation → eligibility floor at effective-n ≥ 20
- [x] pure: propose → null for unknown category; correct delta for known
- [x] pure: isImprovement → non-overlapping Wilson required
- [x] live-DB: backtest + OOS on a seeded range → promotion writes a NEW scoring_config row
- [x] live-DB: bootstrap gate defers promotion; re-run picks up
- [x] structural: no LLM import in the propose module (rule 13)

## 8. Wrap-up
- [x] typecheck + full suite green
- [x] ARCHIVE + completion summary
- [x] **M7 COMPLETE** — record what M8 (dashboard) picks up
