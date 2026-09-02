# Tasks: m7-judge-agent

## 1. Evidence assembly (`agents/perp/judge/evidence.ts`)
- [ ] `buildEvidence(db, signalId)` — reads signal + signal_feature + signal_risk +
      brain.historicalEdge; pure output; NO raw OHLCV in the prompt (rule 14)

## 2. Prompt registry (`agents/perp/judge/prompts.ts`)
- [ ] `JUDGE_PROMPTS` keyed by version; `JUDGE_VERSION_CURRENT`
- [ ] a change to any prompt bumps the version — asserted by a docstring test

## 3. Response schema (`agents/perp/judge/schema.ts`)
- [ ] Zod schema per design.md, discriminated `invalidators`, capped strings + arrays

## 4. Judge agent (`agents/perp/judge/index.ts`)
- [ ] `judgeAgent`: EVENT trigger on `signal.created` when risk_level != 'INVALIDATED'
- [ ] `analyze` — build evidence → `callWithLog` → validate → return `AgentOutput`
      shaped for `signal_feature`
- [ ] on LLM failure: return null → no signal_feature row → gate defers (change 3)
- [ ] memecoin → throw ValidationError with §40.14 citation

## 5. Wiring
- [ ] register in the M4 SignalEngine's post-signal pipeline via existing bus subscription
- [ ] `agents/index.ts` export

## 6. Tests
- [ ] unit: evidence builder deterministic; contains only permitted fields
- [ ] unit: Zod rejects out-of-range / unknown invalidator type / empty thesis
- [ ] unit: prompt-version constant is stable across import (bump = review-visible)
- [ ] live-DB integration with a mock LLM: writes signal_feature{agentKey='judge'}, emits event
- [ ] mock LLM failure: no signal_feature row, no event
- [ ] memecoin refused with §40.14 citation

## 7. Wrap-up
- [ ] typecheck + full suite green
- [ ] ARCHIVE + completion summary
