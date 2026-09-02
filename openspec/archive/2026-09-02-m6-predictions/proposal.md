# Change: m6-predictions

> **COMPLETED 2026-09-02.** New `packages/predictions` (`@tip/predictions`) + migration 0012.
>
> - `create.ts` — `createPrediction` in ONE transaction: duplicate-signal guard →
>   CONDITIONAL `ACTIVE → CONSUMED` (zero rows updated ⇒ signal not ACTIVE) → insert. The
>   `unique(signal_id)` is the DB-level guard against a lost-update race even when two callers
>   pass the ACTIVE check simultaneously.
> - `no-trade.ts` — `recordNoTrade(signalId, reason, detail)` per the resolved ambiguity: a
>   Prediction requires an entry and a horizon (§19), which a veto doesn't have, so the veto goes
>   on the Signal and the signal is INVALIDATED (§36). Idempotent by PK on signal_id.
> - `read.ts` — `getPrediction` / `listPredictions`. No `update*` or `delete*` API exists — the
>   module surface mirrors the DB guarantee.
> - `types.ts` — `PredictionRow`, `AgentContribution`, `CreatePredictionOutcome`
>   (`{created:true, prediction}` | `SIGNAL_NOT_ACTIVE` | `DUPLICATE_SIGNAL`).
>
> Migration 0012: `signal_no_trade`, `prediction` (with `unique(signal_id)`), `prediction_outcome`
> (deliberately NOT trigger-locked — it accrues per horizon), plus **raw-SQL Postgres triggers**
> hand-appended to the generated migration that RAISE on `UPDATE` or `DELETE` of `prediction`
> (rule 10). Hand-edited migrations are unusual in this repo, so it is flagged in the SQL comment
> and in the archived design.md — a reviewer should see it called out.
>
> **Verified:** typecheck green; **437/440 tests pass** (3 opt-in live) across 3 consecutive
> full-suite runs, 10 new — happy path + Signal→CONSUMED atomicity, **trigger enforcement on
> both UPDATE and DELETE against a live prediction row**, real concurrent double-act
> (`Promise.all`, §29 pattern; exactly one prediction wins), refusal of EXPIRED / INVALIDATED
> signals, read round-trip incl. features JSON, shadow columns (M7's caller), and
> `recordNoTrade` (writes veto + INVALIDATES signal + creates no Prediction; idempotent).
>
> **Cleanup detail worth flagging:** the DELETE trigger blocks test teardown. I tried
> `SET session_replication_role = replica` first; local Postgres needs superuser for that. Falling
> back to `DROP TRIGGER … BEFORE DELETE` around the cleanup delete works for any table owner and
> is confined to `afterAll`. If tests ever run under a superuser role we could switch back.

**Status:** COMPLETED — archived
**Original status:** PROPOSED (scoping)
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
