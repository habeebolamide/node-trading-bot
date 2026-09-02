# Tasks: m5-agent-memory

## 1. Schema (migration 0011)
- [ ] `brain_agent_memory` — add effective_n, effective_wins, wilson_lower, wilson_upper,
      evidence, occurrence_count, sample_since; plus the Risk-Agent veto columns
      (vetoed_count, vetoed_would_have_lost) left null until M7
- [ ] `brain_agent_occurrence` — new, append-only, `unique(prediction_id, agent_key, agent_version)`
- [ ] docstrings on BOTH `agent_performance` (per-TradingAgent, M4) and `brain_agent_memory`
      (domain-wide counterfactual, this change) stating which answers which question
- [ ] generate + apply

## 2. Counterfactual scoring (`packages/brain/src/agent-memory.ts`)
- [ ] `agentLean(output)` — signed lean per the design.md table; null for no-opinion,
      excluded for Token Risk, bias-only for Market Regime, long-only handling for memecoin
- [ ] `recordAgentOutcome(db, prediction, realizedDirection, contributions)` — one occurrence
      per contributing agent, idempotent
- [ ] `recomputeAgentMemory(db, domain, agentKey, agentVersion, asOf)` — shared
      `wilsonInterval` + `recencyWeight`, effective-n ≥ 10 trust bar
- [ ] NO path from this module to a ScoringConfig write (§16 descriptive-not-prescriptive) —
      assert by absence of import, and say so in the module docstring

## 3. Facade
- [ ] `brain.agent(agentKey, version, asOf)` on the change-3 `Brain` interface
- [ ] no roll-up-across-versions accessor (CLAUDE.md "do not blend versions")

## 4. Tests
- [ ] dissenting agent credited on a losing composite; agreeing agent debited
- [ ] zero-lean excluded, not scored bearish; Market Regime on bias not enum; Token Risk excluded
- [ ] version isolation — v2 INSUFFICIENT while v1 is rich
- [ ] idempotent replay
- [ ] shared-helper equality: same inputs → identical numbers as change 1's setup memory
- [ ] typecheck + full suite green

## 5. Wrap-up — M5 COMPLETE
- [ ] ARCHIVE + completion summary
- [ ] M5 summary note: which stubs died (historical-edge-stub, confidence 0.5), what M6 must
      call (`updateSetupMemory`, `recordAgentOutcome`) and from where (outcome-resolution
      handler in the paper engine, §41)
