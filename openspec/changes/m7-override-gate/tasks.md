# Tasks: m7-override-gate

## 1. Config
- [ ] extend `ScoringConfig` with `overrideGate: { flipDetConfMax, flipGap, standAsideDetConfMin,
      standAsideLlmConfMax }`; §18 defaults
- [ ] `validateScoringConfig` — thresholds ∈ (0, 1)

## 2. Pure gate (`packages/agents/src/perp/judge/gate.ts`)
- [ ] `decide(input)` — §18's rule table verbatim, short-circuit order
- [ ] `signSameDirection` collapse across STRONG_LONG/LONG/WEAK_LONG (etc.)
- [ ] NEUTRAL judge → DEFER

## 3. Schema (migration 0016)
- [ ] `judge_decision` — (signal_id, judge_version) PK · judgeAction · detConf · judgeConf ·
      gap · configVersion · createdAt · flipRefusedByPlanner boolean

## 4. Consumer
- [ ] subscribes `judge.evaluation.completed`
- [ ] AGREE / DEFER → `createPrediction` (deterministic direction)
- [ ] FLIP → `planTrade(judgeDirection)`; if NO_TRADE → downgrade to DEFER, deterministic prediction;
      else create Prediction with Judge direction + emit `signal.flipped`
- [ ] STAND_ASIDE → `transitionSignal(INVALIDATED)` + emit `signal.stood_aside`; NO real Prediction
- [ ] every decision writes `judge_decision`; the Judge's `signal_feature.features` gets `judgeAction`

## 5. LLM-failure path
- [ ] no Judge event within the wait window → the existing deterministic consumer (M4) creates
      the Prediction; the gate does nothing. Documented as "graceful degradation by absence"

## 6. Tests
- [ ] pure decide: 4 worked examples from §18
- [ ] pure decide: judgeConf > detConf guard on FLIP; NEUTRAL judge → DEFER
- [ ] integration: FLIP that fails planTrade → DEFER + deterministic, no shadow
- [ ] integration: STAND_ASIDE → INVALIDATED + judge_decision row
- [ ] integration: absent Judge event → deterministic prediction, no judge_decision
- [ ] version isolation: config bump changes decision without touching old predictions

## 7. Wrap-up
- [ ] typecheck + full suite green
- [ ] ARCHIVE + completion summary
