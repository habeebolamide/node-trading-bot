# Change: m7-shadow-predictions

**Status:** PROPOSED (scoping)
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
