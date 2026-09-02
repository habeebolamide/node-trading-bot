# Design: m7-override-gate

## The gate as a pure function

```ts
type JudgeAction = 'AGREE' | 'FLIP' | 'STAND_ASIDE' | 'DEFER';

function decide(input: {
  detDirection: Direction;
  detConfidence: number;
  judgeDirection: Direction;
  judgeConfidence: number;
  config: OverrideGateConfig;
}): JudgeAction;
```

§18's rules, in the order they must be applied (short-circuiting on the first that matches):

```
if signSameDirection(det, judge)                                 → AGREE
gap = |detConf − judgeConf|
if detConf < flipDetConfMax
   && gap >= flipGap
   && judgeConf > detConf                                        → FLIP
if detConf >= standAsideDetConfMin
   && judgeConf < standAsideLlmConfMax
   && gap >= flipGap                                             → STAND_ASIDE
otherwise                                                        → DEFER
```

`signSameDirection` treats `LONG*` as +1 and `SHORT*` as −1 (an M4 signal never returns bare
LONG/SHORT — it's `STRONG_LONG` etc.). NEUTRAL is only reachable from the Judge; a NEUTRAL
Judge output with any deterministic direction is treated as DEFER (nothing to flip TO).

## Ambiguity — dissent rows

**Resolved: log a dissent row on EVERY judge event where `judgeAction != AGREE`.** DEFER-with-
agreement is not a dissent (§18 defines agreement as sign(det) == sign(judge)). A dissent row
is what §18 needs for "direction-agreement rates and per-side calibration can be computed from
those rows." A row per resolved-with-agreement event would be noise; the deterministic
Prediction and its outcome carry that story anyway.

## Persistence

Two options considered:
- **A** new `judge_decision` table — one row per Judge event with `signalId`, `predictionId?`,
  `judgeAction`, `detConf`, `judgeConf`, `gap`, `configVersion`
- **B** stamp `judgeAction` on `signal_feature.features` (JSON) of the Judge's row

**Chosen: BOTH, deliberately.**
- `signal_feature` gets the `judgeAction` in its JSON so §22 attribution reads a single row.
- A new small `judge_decision` table (migration 0016) gets one row per decision keyed on
  `(signalId, judgeVersion)` so §23's cost-vs-value join is a single query.

Duplicating is cheap here (one wider row + one narrow indexable row), and each consumer wants
a different shape.

## STAND_ASIDE = INVALIDATED

§36 already gives Signal an `INVALIDATED` state; §18 explicitly says "STAND ASIDE reuses the
existing invalidator evaluation path — mechanically the same event." The gate calls
`transitionSignal(db, signalId, 'INVALIDATED')` and records `judgeAction=STAND_ASIDE` on the
`judge_decision` row. Downstream sees an INVALIDATED signal exactly as it would a Risk Agent
invalidation — the shadow-prediction path (change 4) distinguishes by `judge_decision.judgeAction`.

## FLIP re-invokes the Trade Planner

§18: "risk gates remain fully deterministic regardless of which side produced the winning
direction — the Judge can only choose which direction those checks get applied to, never bypass
them." Concretely: after a FLIP, the consumer calls `planTrade(...)` again with
`direction = judge.direction`; if `NO_TRADE` fires (R:R, sizing), the flip is REFUSED (
`judgeAction` is downgraded to DEFER on the record, and the deterministic Prediction is made
instead — because the deterministic side already cleared the planner in a prior step).

Documenting this because it's non-obvious: "FLIP failed the planner" is a real outcome and the
system MUST NOT create a shadow with no real trade in that case; it's just a normal deterministic
Prediction with a dissent row.

## LLM-failure = DEFER by absence

There is deliberately no timeout on the gate's side. The Judge (change 2) either emits an event
or it does not. The gate is subscribed and only reacts on emission. When the Judge fails to
produce, the deterministic side's own consumer (an existing M4 subscriber) creates the
Prediction normally — no coordination between the two paths beyond both listening to the same
Signal-lifecycle events. This matches §18's "LLM down = trades without narrative or override
capability" verbatim.

## Testing

- Pure `decide()`: cover §18's four worked examples exactly (0.45/0.85 → FLIP, 0.90/0.55 →
  STAND_ASIDE, 0.90/0.75 → DEFER, 0.40/0.25 → DEFER).
- `judgeConf > detConf` on FLIP — a weaker Judge dissent NEVER flips a weak deterministic call.
- Signs collapsed correctly across STRONG_LONG/LONG/WEAK_LONG (all +1) and their SHORT twins.
- NEUTRAL from the Judge → DEFER.
- Integration: FLIP that fails the Trade Planner degrades to DEFER + deterministic Prediction
  (no shadow orphaned).
- Integration: STAND_ASIDE transitions the Signal to INVALIDATED + writes `judge_decision`.
- Integration: LLM failure (no Judge event) → deterministic Prediction created, no
  `judge_decision` row.
- Version isolation: `overrideGate` config change bumps `configVersion`; a Prediction created
  after the bump reads the new thresholds.
