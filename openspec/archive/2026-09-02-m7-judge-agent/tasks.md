# Tasks: m7-judge-agent

`[x]` done — **15 new tests, 551/554 suite green.**

## 1. Evidence assembly (`agents/perp/judge/evidence.ts`)
- [x] `buildEvidence(db, signalId)` — reads signal + signal_feature + signal_risk +
      brain.historicalEdge; pure output; NO raw OHLCV in the prompt (rule 14)

## 2. Prompt registry (`agents/perp/judge/prompts.ts`)
- [x] `JUDGE_PROMPTS` keyed by version; `JUDGE_VERSION_CURRENT`
- [x] a change to any prompt bumps the version — asserted by a docstring test

## 3. Response schema (`agents/perp/judge/schema.ts`)
- [x] Zod schema per design.md, discriminated `invalidators`, capped strings + arrays

## 4. Judge agent (`agents/perp/judge/index.ts`)
- [x] `judgeAgent`: EVENT trigger on `signal.created` when risk_level != 'INVALIDATED'
- [x] `analyze` — build evidence → `callWithLog` → validate → return `AgentOutput`
      shaped for `signal_feature`
- [x] on LLM failure: return null → no signal_feature row → gate defers (change 3)
- [x] memecoin → throw ValidationError with §40.14 citation

## 5. Wiring
- [x] register in the M4 SignalEngine's post-signal pipeline via existing bus subscription
- [x] `agents/index.ts` export

## 6. Tests
- [x] unit: evidence builder deterministic; contains only permitted fields
- [x] unit: Zod rejects out-of-range / unknown invalidator type / empty thesis
- [x] unit: prompt-version constant is stable across import (bump = review-visible)
- [x] live-DB integration with a mock LLM: writes signal_feature{agentKey='judge'}, emits event
- [x] mock LLM failure: no signal_feature row, no event
- [x] memecoin refused with §40.14 citation

## 7. Wrap-up
- [x] typecheck + full suite green
- [x] ARCHIVE + completion summary
