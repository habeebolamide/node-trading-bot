# Tasks: m7-trade-autopsy

## 1. Schema (migration 0018)
- [ ] `trade_autopsy` — (id, prediction_id UNIQUE, setup_id, outcome, root_cause,
      failure_category, success_factor, explanation, contributing_factors, agent_failures,
      lesson, recommendation, autopsy_version, llm_call_log_id, status, created_at)
- [ ] CHECK constraint: (WIN → successFactor, no failureCategory) XOR (LOSS → failureCategory,
      no successFactor) XOR (any with status=FAILED_LLM → both null)

## 2. Evidence package (`packages/agents/src/perp/autopsy/evidence.ts`)
- [ ] `buildAutopsyEvidence(db, predictionId, planningHorizon)` — three-part §24 structure,
      bounded to T0..T2 via `AsOfMarketData(T2)`

## 3. Response schema (`packages/agents/src/perp/autopsy/schema.ts`)
- [ ] AutopsyOutput per design.md; caps everywhere; WIN/LOSS field-presence rule

## 4. Runner (`packages/agents/src/perp/autopsy/index.ts`)
- [ ] subscribes `prediction.resolved` (planning horizon only)
- [ ] perp only — memecoin throws with §24 citation
- [ ] SUCCESS path: insert row + link to llm_call_log
- [ ] FAILURE path: insert row with status=FAILED_LLM and null diagnostics
- [ ] retry: UPDATE-in-place on prediction_id for FAILED_LLM rows

## 5. Tests
- [ ] pure: evidence-builder bounded to [T0, T2]; data past T2 does not leak
- [ ] Zod: WIN + failureCategory rejected; LOSS + successFactor rejected
- [ ] live-DB: SUCCESS path writes trade_autopsy + llm_call_log
- [ ] live-DB: LLM failure writes FAILED_LLM row; retry updates same row
- [ ] memecoin refused with §24 citation
- [ ] idempotency: same prediction resolved twice → one autopsy row

## 6. Wrap-up
- [ ] typecheck + full suite green
- [ ] ARCHIVE + completion summary
