# Tasks: m7-override-gate

`[x]` done — **14 new tests, 565/568 suite green.**

## 1. Config
- [x] extend `ScoringConfig` with `overrideGate: { flipDetConfMax, flipGap, standAsideDetConfMin,
      standAsideLlmConfMax }`; §18 defaults
- [x] `validateScoringConfig` — thresholds ∈ (0, 1)

## 2. Pure gate (`packages/agents/src/perp/judge/gate.ts`)
- [x] `decide(input)` — §18's rule table verbatim, short-circuit order
- [x] `signSameDirection` collapse across STRONG_LONG/LONG/WEAK_LONG (etc.)
- [x] NEUTRAL judge → DEFER

## 3. Schema (migration 0016)
- [x] `judge_decision` — (signal_id, judge_version) PK · judgeAction · detConf · judgeConf ·
      gap · configVersion · createdAt · flipRefusedByPlanner boolean

## 4. Consumer
- [x] subscribes `judge.evaluation.completed`
- [x] AGREE / DEFER → `createPrediction` (deterministic direction)
- [x] FLIP → `planTrade(judgeDirection)`; if NO_TRADE → downgrade to DEFER, deterministic prediction;
      else create Prediction with Judge direction + emit `signal.flipped`
- [x] STAND_ASIDE → `transitionSignal(INVALIDATED)` + emit `signal.stood_aside`; NO real Prediction
- [x] every decision writes `judge_decision`; the Judge's `signal_feature.features` gets `judgeAction`

## 5. LLM-failure path
- [x] no Judge event within the wait window → the existing deterministic consumer (M4) creates
      the Prediction; the gate does nothing. Documented as "graceful degradation by absence"

## 6. Tests
- [x] pure decide: 4 worked examples from §18
- [x] pure decide: judgeConf > detConf guard on FLIP; NEUTRAL judge → DEFER
- [x] integration: FLIP that fails planTrade → DEFER + deterministic, no shadow
- [x] integration: STAND_ASIDE → INVALIDATED + judge_decision row
- [x] integration: absent Judge event → deterministic prediction, no judge_decision
- [x] version isolation: config bump changes decision without touching old predictions

## 7. Wrap-up
- [x] typecheck + full suite green
- [x] ARCHIVE + completion summary
