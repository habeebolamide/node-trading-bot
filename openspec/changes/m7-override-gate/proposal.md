# Change: m7-override-gate

**Status:** PROPOSED (scoping)
**Milestone:** M7 (change 3 of 6)
**Implements:** §18 (FLIP / STAND_ASIDE / DEFER gate) · §36 (STAND_ASIDE → INVALIDATED) ·
§18 LLM-failure path · §33 rule 20 (still paper trading; the gate never touches real money)

## What's changing

The gate that consumes the deterministic composite + the Judge's `judge.evaluation.completed`
event and produces at most one directional decision. The mechanics are §18 verbatim; this
change persists the decision and drives Prediction creation (change 4 handles the shadow
prediction row itself).

1. **`overrideGate` config** on `ScoringConfig` — the four thresholds §18 names:
   `flipDetConfMax`, `flipGap`, `standAsideDetConfMin`, `standAsideLlmConfMax`. Defaults per
   §18 (`0.7`, `0.2`, `0.7`, `0.7`). Versioned like every other scoring input (rule 16).
2. **`gate.ts`** — pure `decide({ deterministic, judge, config })` → `AGREE | FLIP | STAND_ASIDE
   | DEFER`. Tabulated §18 rules; no thresholds hardcoded, all from `config.overrideGate`.
3. **Consumer** — subscribes `judge.evaluation.completed`, joins the Signal, computes the
   decision, and:
   - **AGREE / DEFER** — creates the Prediction via M6's `createPrediction` (deterministic
     direction). `judgeAction` stamped on the `signal_feature.features` (Judge row).
   - **FLIP** — creates the Prediction with the Judge's direction (still via `createPrediction`;
     the Trade Planner reruns for the flipped direction so risk gates still apply — §18: "risk
     gates remain fully deterministic regardless of which side produced the winning direction").
     Also emits `signal.flipped` → change 4's shadow-prediction path.
   - **STAND_ASIDE** — no real Prediction; the Signal transitions to `INVALIDATED` (§36 says
     "STAND ASIDE reuses the existing invalidator evaluation path"). Emits `signal.stood_aside`
     → change 4's shadow-only path.
4. **LLM-failure default = DEFER** — no Judge event within a timeout window, the gate never
   fires, deterministic runs (§18: "LLM down = trades without narrative or override capability,"
   graceful degradation). No FLIP is structurally reachable without a Judge event.
5. **`judgeAction`** column on `signal_feature` (or on a small companion table) so §23's
   evaluation can group by decision.

## Why this is a distinct change from the Judge itself

The Judge produces evidence; the gate decides what to do with it. Splitting keeps §18's
threshold table in one file and its persistence in one place. It also means a "tighten the
FLIP gate" adjustment is a one-file change without touching the Judge itself.

## What this change does NOT do

- **No shadow prediction rows.** The `is_shadow` / `shadow_of` columns already exist (M6 change
  2); populating them is change 4.
- **No autopsy or hypothesis pipeline.** Those are changes 5/6.
- **No real-money paths.** Rule 20 — the gate operates on paper predictions.

## Ambiguity to resolve (see design.md)

§18's four rules are precise but leave the DEFER case's *observability* implicit. Do we log a
row for every DEFER, or only when directions disagree? A DEFER-with-agreement is uninteresting
noise; a DEFER-with-disagreement is the "logged dissent row" §18 names as the population that
answers direction-agreement rate without any shadow execution.
