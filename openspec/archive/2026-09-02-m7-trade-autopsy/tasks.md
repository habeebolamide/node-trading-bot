# Tasks: m7-trade-autopsy

`[x]` done — **12 new tests, 584/587 suite green.**

## 1. Schema (migration 0018)
- [x] `trade_autopsy` — (id, prediction_id UNIQUE, setup_id, outcome, root_cause,
      failure_category, success_factor, explanation, contributing_factors, agent_failures,
      lesson, recommendation, autopsy_version, llm_call_log_id, status, created_at)
- [x] CHECK constraint: (WIN → successFactor, no failureCategory) XOR (LOSS → failureCategory,
      no successFactor) XOR (any with status=FAILED_LLM → both null)

## 2. Evidence package (`packages/agents/src/perp/autopsy/evidence.ts`)
- [x] `buildAutopsyEvidence(db, predictionId, planningHorizon)` — three-part §24 structure,
      bounded to T0..T2 via `AsOfMarketData(T2)`

## 3. Response schema (`packages/agents/src/perp/autopsy/schema.ts`)
- [x] AutopsyOutput per design.md; caps everywhere; WIN/LOSS field-presence rule

## 4. Runner (`packages/agents/src/perp/autopsy/index.ts`)
- [x] subscribes `prediction.resolved` (planning horizon only)
- [x] perp only — memecoin throws with §24 citation
- [x] SUCCESS path: insert row + link to llm_call_log
- [x] FAILURE path: insert row with status=FAILED_LLM and null diagnostics
- [x] retry: UPDATE-in-place on prediction_id for FAILED_LLM rows

## 5. Tests
- [x] pure: evidence-builder bounded to [T0, T2]; data past T2 does not leak
- [x] Zod: WIN + failureCategory rejected; LOSS + successFactor rejected
- [x] live-DB: SUCCESS path writes trade_autopsy + llm_call_log
- [x] live-DB: LLM failure writes FAILED_LLM row; retry updates same row
- [x] memecoin refused with §24 citation
- [x] idempotency: same prediction resolved twice → one autopsy row

## 6. Wrap-up
- [x] typecheck + full suite green
- [x] ARCHIVE + completion summary
