# Tasks: m5-agent-memory

`[x]` done — **18 new tests, 395/398 suite green (6 consecutive clean runs). M5 COMPLETE.**

## 1. Schema (migration 0011)
- [x] `brain_agent_memory` — add effective_n, effective_wins, wilson_lower, wilson_upper,
      evidence, occurrence_count, sample_since; plus the Risk-Agent veto columns
      (vetoed_count, vetoed_would_have_lost) left null until M7
- [x] `brain_agent_occurrence` — new, append-only, `unique(prediction_id, agent_key, agent_version)`
- [x] docstrings on BOTH `agent_performance` (per-TradingAgent, M4) and `brain_agent_memory`
      (domain-wide counterfactual, this change) stating which answers which question
- [x] generate + apply

## 2. Counterfactual scoring (`packages/brain/src/agent-memory.ts`)
- [x] `agentLean(output)` — signed lean per the design.md table; null for no-opinion,
      excluded for Token Risk, bias-only for Market Regime, long-only handling for memecoin
- [x] `recordAgentOutcome(db, prediction, realizedDirection, contributions)` — one occurrence
      per contributing agent, idempotent
- [x] `recomputeAgentMemory(db, domain, agentKey, agentVersion, asOf)` — shared
      `wilsonInterval` + `recencyWeight`, effective-n ≥ 10 trust bar
- [x] NO path from this module to a ScoringConfig write (§16 descriptive-not-prescriptive) —
      asserted by a test that strips comments from the source and greps for `ScoringConfig`,
      `agentWeights` and `@tip/trading-agents`, so the module's own explanation of the rule
      neither satisfies nor trips the check

## 3. Facade
- [x] `brain.agent(agentKey, version, asOf)` on the change-3 `Brain` interface
- [x] no roll-up-across-versions accessor (CLAUDE.md "do not blend versions")

## 4. Tests
- [x] dissenting agent credited on a losing composite; agreeing agent debited
- [x] zero-lean excluded, not scored bearish; Market Regime on bias not enum; Token Risk excluded
- [x] version isolation — v2 INSUFFICIENT while v1 is rich
- [x] idempotent replay
- [x] shared-helper equality: same inputs → identical numbers as change 1's setup memory
- [x] typecheck + full suite green

## 5. Wrap-up — M5 COMPLETE
- [x] ARCHIVE + completion summary
- [x] M5 summary note: which stubs died (historical-edge-stub, confidence 0.5), what M6 must
      call (`updateSetupMemory`, `recordAgentOutcome`) and from where (outcome-resolution
      handler in the paper engine, §41)
