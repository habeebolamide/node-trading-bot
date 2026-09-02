# Change: m7-shadow-predictions

**Status:** COMPLETED — archived 2026-09-02
**Original status:** PROPOSED (scoping)

> **COMPLETED.** Populates the `isShadow` / `shadowOf` columns m6 schema'd.
> - Migration 0017: `paper_position.is_shadow`. `openPositionCount` excludes shadows so a
>   FLIP's real+shadow pair does not blow through `maxConcurrentPositions=1`.
> - Migration 0018: dropped `prediction_signal_uq`, added a **partial unique**
>   `prediction_signal_real_uq ON prediction(signal_id) WHERE is_shadow = false`. Real
>   predictions still cap at one per signal; shadows share the same signal_id and are
>   distinguished by `is_shadow`.
> - `packages/predictions/src/shadow.ts` — `insertFlipShadow(...)` and
>   `insertStandAsideShadow(...)` do direct INSERTs (the rule-10 trigger blocks UPDATE/DELETE
>   but INSERT is fine). NO_TRADE plan → no shadow (parity with the real path).
> - `feedBrainOnce` (m6c4 sweep) now SKIPS `isShadow=true` predictions — the Brain-isolation
>   rule from `design.md`: a Judge that consistently flips right would otherwise bake its
>   preference back into `Historical Edge` via a back channel §18's narrow gate is designed to
>   prevent. Same idea for MEMORY as §33 rule 13 is for CALCULATION.
> - `packages/evaluation/src/metrics/shadow.ts` — `compareShadowVsReal(...)` (FLIP group vs
>   shadow group) and `compareShadowVsBaseline(...)` (STAND_ASIDE shadow vs deterministic
>   AGREE/DEFER baseline). Reads from `prediction_outcome` joined to `judge_decision` — NOT
>   from the Brain.
>
> **Verified:** typecheck green; **572/575 tests pass** (3 opt-in live). 7 new — shadow
> handlers (4 incl. FLIP writes with shadow_of pointing at real, NO_TRADE writes nothing,
> STAND_ASIDE writes shadow_of=null, openPositionCount excludes shadow so the 1-max portfolio
> stays honest), shadow reporting (3 incl. empty=null groups, FLIP real+shadow win-rate
> comparison, STAND_ASIDE vs baseline).
**Milestone:** M7 (change 4 of 6)
**Implements:** §18 (shadow evaluation for FLIP + STAND_ASIDE) · §23 (shadow-vs-real comparison
that answers "does the Judge add value") · §13 (Prediction `isShadow`/`shadowOf`) · §33 rule 20

## What's changing

Populates the `isShadow` / `shadowOf` columns M6 change 2 schema'd. This is the change that
makes §23's headline question — "do FLIPs actually improve outcomes?" and "do STAND ASIDEs
actually improve outcomes?" — answerable.

1. **`signal.flipped` handler** — on FLIP: the REAL prediction (Judge direction) already exists
   from change 3. This handler creates a SHADOW prediction for the DETERMINISTIC direction, with
   `isShadow=true` and `shadowOf=<real prediction id>`. Both predictions go through the same
   Paper Engine → Outcome Engine pipeline, so both accumulate real outcomes (§18: "full outcome
   tracking").
2. **`signal.stood_aside` handler** — on STAND_ASIDE: NO real prediction exists. This handler
   creates ONE SHADOW prediction for the deterministic direction (§18: "SHADOW = deterministic
   direction"). `shadowOf` is null in this case — there is no real to shadow — and the row
   carries `judgeAction=STAND_ASIDE` on its features so the reporting join is straightforward.
3. **Shadow paper positions** — shadows go through `openPosition` normally; the paper portfolio
   has to be able to hold shadow AND real positions concurrently without the shadow counting
   toward `maxConcurrentPositions`. Two options considered (see design.md): a `is_shadow`
   column on `paper_position`, or a separate `paper_portfolio` per shadow. Chosen: column, plus
   the count query excludes shadows.
4. **Shadow outcomes flow to the SAME Brain occurrence log** — but with a marker
   (`brain_setup_occurrence.was_shadow`? see design.md) so §23's aggregation can separate them
   without a schema change downstream. Alternative: shadows don't feed the Brain at all — see
   design.md for the resolved choice.
5. **`shadowEvaluation.ts`** reporting helper — `compareShadowVsReal(configVersion, asOf)` for
   FLIP; `compareShadowVsBaseline(configVersion, asOf)` for STAND_ASIDE. Both return the exact
   §23 metric block (win rate, median return, drawdown per group).

## Why this is a distinct change from the gate

Change 3 makes the DECISION; this change PERSISTS and MEASURES the counterfactuals. Splitting
means an "adjust FLIP thresholds" change touches gate.ts only, and a "how do shadows perform"
report touches this file only.

## Ambiguity to resolve (see design.md)

**Should shadow outcomes feed BrainSetupMemory + BrainAgentMemory the same way real outcomes
do?** If yes: shadow track records participate in future Historical Edge reads, which is a
subtle form of "the Judge influences the deterministic engine" via the Brain. If no: §23 has
one place to look for shadow stats, but the Brain misses free data. Resolved in design.md.
