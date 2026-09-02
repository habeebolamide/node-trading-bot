# Tasks: m7-hypothesis-pipeline

## 1. Schema (migration 0019)
- [ ] `learning_hypothesis` — full field list per design.md, index (status, setup_id)

## 2. Aggregation (`packages/evaluation/src/hypothesis/aggregate.ts`)
- [ ] `aggregatePatterns(db, {domain, asOf})` — recency-weighted effective-n per
      (setupId, category, categoryKind) using @tip/brain helpers
- [ ] refuses to yield below effective-n ≥ 20 (§24)

## 3. Proposal (`packages/evaluation/src/hypothesis/propose.ts`)
- [ ] `CATEGORY_TO_ADJUSTMENT_V1` — deterministic table
- [ ] `proposeFromPattern(pattern)` → LearningHypothesis row shape | null

## 4. Backtest + OOS (`packages/evaluation/src/hypothesis/backtest.ts`)
- [ ] `runBacktest` — reuses walkForwardFolds + evaluateFold
- [ ] `runOutOfSample` — held-out later window, disjoint by construction
- [ ] `isImprovement` — accuracy + meanAlpha both up, non-overlapping Wilson (§M6c5)

## 5. Promotion (`packages/evaluation/src/hypothesis/promote.ts`)
- [ ] `promoteHypothesis` — reads current config, applies delta, inserts NEW scoring_config row
- [ ] never touches old config rows (rule 16)

## 6. Bootstrap gate
- [ ] `isBootstrapping` blocks PROMOTED; status becomes DEFERRED_BOOTSTRAP; re-runnable

## 7. Tests
- [ ] pure: aggregation → eligibility floor at effective-n ≥ 20
- [ ] pure: propose → null for unknown category; correct delta for known
- [ ] pure: isImprovement → non-overlapping Wilson required
- [ ] live-DB: backtest + OOS on a seeded range → promotion writes a NEW scoring_config row
- [ ] live-DB: bootstrap gate defers promotion; re-run picks up
- [ ] structural: no LLM import in the propose module (rule 13)

## 8. Wrap-up
- [ ] typecheck + full suite green
- [ ] ARCHIVE + completion summary
- [ ] **M7 COMPLETE** — record what M8 (dashboard) picks up
