# Change: m6-predictions

**Status:** PROPOSED (scoping)
**Milestone:** M6 (change 2 of 6)
**Implements:** §19 Prediction System · §13 (`Prediction`, `PredictionOutcome`, `isShadow` /
`shadowOf`) · §36 Signal Lifecycle (CONSUMED transition) · §33 rules 10, 16, 8

## What's changing

The immutable record of "we said this would happen, at this time, under this config."

1. **`prediction` table** — the §19 field list: agent, domain, symbol, createdAt, horizon,
   direction, confidence, score, entry reference, thesis, features, invalidators, and the
   **mandatory `configVersion` FK** to the `ScoringConfig` row active at creation.
2. **INSERT-only enforcement** (rule 10). Predictions are locked after creation. This is enforced
   at the DB level, not by developer discipline — see `design.md`.
3. **`prediction_outcome` table** — the shape change 4 fills, carrying `outcomeResolution`
   (`TICK` | `CANDLE_1M_CONSERVATIVE`, §21) so live and seeded populations stay separable forever
   even though the Brain aggregates them together.
4. **Shadow predictions** — `isShadow` / `shadowOf` columns per §13. The §18 Judge-override
   mechanism that produces them is M7; the schema and the creation path exist here so M7 adds a
   caller, not a migration.
5. **Signal → Prediction** — creating a prediction transitions its Signal to `CONSUMED` (§36),
   atomically, so one signal cannot spawn two predictions.

## Why `configVersion` is load-bearing

§19 spends a whole resolved block on this: without the FK, "the moment a `LearningHypothesis`
gets promoted (§24) and weights change, every performance stat and Attribution (§22) breakdown
silently blends predictions made under two different scoring configs into one number, with no way
to separate them after the fact." It is `notNull` with a real foreign key, and there is no code
path that creates a prediction without one.

## What this change does NOT do

- **No outcome resolution** — change 4.
- **No paper positions** — change 3. A Prediction is a *claim*; a paper position is what happens
  when you act on one. §13 keeps them as separate entities and so does this.
- **No Judge, no thesis generation.** `thesis` is a nullable text column here; M7 fills it. A
  deterministic prediction with no LLM narrative is a complete, valid prediction.

## Ambiguity to resolve (see `design.md`)

**Nothing in the plan says what happens when a TradeSetup is `NO_TRADE`.** Does a vetoed signal
produce a prediction (a recorded "we declined") or nothing at all? This materially affects every
denominator in M6's metrics.
