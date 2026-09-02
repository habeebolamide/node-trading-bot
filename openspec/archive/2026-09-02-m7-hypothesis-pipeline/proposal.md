# Change: m7-hypothesis-pipeline

**Status:** COMPLETED — archived 2026-09-02 — M7 COMPLETE
**Original status:** PROPOSED (scoping)

> **COMPLETED.** Migration 0020: `learning_hypothesis` (id · setup_id · domain · category ·
> category_kind · evidence_count · proposed_change · status · backtest_result · oos_result ·
> from_config_version · to_config_version · created_at · resolved_at).
> - `propose.ts` — deterministic `CATEGORY_TO_ADJUSTMENT_V1` table. LLM does NOT propose the
>   number; the pattern (recurring category) triggers a proposal, the delta is code. Unknown
>   category → null (structural refusal to guess). `applyWeightDelta` renormalizes to sum 1.
> - `aggregate.ts` — recency-weighted effective-n per (setupId, category, kind); refuses to
>   yield below **effective-n ≥ 20** (§24 eligibility floor, higher than Setup Memory's ≥ 10).
> - `pipeline.ts` — `openHypotheses` sweep. Idempotent per (setupId, category, kind) via
>   findExistingOpen for PROPOSED rows.
> - `backtest.ts` — `pickBacktestFold` / `pickOOSFold` disjoint by construction; `isImprovement`
>   requires accuracy AND meanAlpha UP AND **non-overlapping Wilson intervals** — the same "no
>   measurable difference" bar M6c5's factor tertile check uses. §24's promotion gate.
> - `promote.ts` — inserts a NEW `scoring_config` row via M4's `updateTradingAgentConfig`
>   (versioned append-only, rule 16). Marks hypothesis PROMOTED with from/to version links.
>
> **Verified:** typecheck green; **607/610 tests pass** (3 opt-in live) across 3 consecutive
> full-suite runs, 23 new — pure propose (10 incl. category-kind match guard, small-delta
> policy, renormalization), pure backtest (5 incl. Wilson-overlap gate cites §24), live-DB
> pipeline + promotion (8 incl. below-floor → no proposal, above-floor → PROPOSED row +
> idempotent second sweep, unknown categories skipped, PROMOTION writes NEW scoring_config
> without touching old, non-promotable status refused, structural rule-13 test that propose.ts
> has no LLM import).
>
> **One test-fixture correction on the way through:** initial T/AS_OF pair set 30 days apart,
> which decayed 25 raw autopsies to effective-n 19.7 — just below the 20 floor. Tightened to
> a 1-hour window so decay doesn't confound the eligibility check.
**Milestone:** M7 (change 6 of 6) — completes M7
**Implements:** §24 hypothesis pipeline (aggregate → propose → backtest → out-of-sample →
promote/reject) · §24 eligibility floor (effective-n ≥ 20, higher than Setup Memory's ≥ 10) ·
§13 `LearningHypothesis` · §16 descriptive-not-prescriptive discipline (this change is the ONE
place a config write can actually happen — through the backtest + out-of-sample gate, never
from a raw LLM opinion) · §33 rule 20 (still paper only)

## What's changing

The only channel in this codebase through which a scoring weight change actually reaches
`ScoringConfig`. §24 is emphatic that no single autopsy — or even the LLM's aggregate opinion
— can edit weights. Change comes only through a proposed hypothesis surviving a backtest AND
an out-of-sample confirmation. This change builds that pipeline.

1. **`learning_hypothesis` table** (§13) — one row per proposed change:
   `setupId`, `failureCategory | successFactor`, `evidenceCount` (effective-n across recurring
   autopsies), `proposedChange` (config diff), `backtestResult` (rows / metrics), `oosResult`,
   `status: PROPOSED | BACKTEST_PENDING | BACKTEST_PASSED | OOS_PENDING | PROMOTED | REJECTED`,
   `createdAt`, `resolvedAt`.
2. **Aggregation** — nightly (or on-demand) sweep over `trade_autopsy` rows: for each `setupId`,
   count effective-n of each `failureCategory` / `successFactor`. Recency-weighted, using the
   domain's Setup Memory half-life (§24: "using the domain's Setup Memory half-life; raw counts
   appear nowhere as a gate").
3. **Eligibility floor: effective-n ≥ 20** (§24 verbatim, higher than §41 Setup Memory's ≥ 10).
   Deliberate split: reading a thin cell's own stats is cheap-wrong (Wilson already down-weights
   it); PROMOTING a weight change is a permanent mutation and gets the higher bar. Enforced
   structurally: the aggregator refuses to propose below 20.
4. **Proposal generation** — pure function `proposeFromPattern({setupId, category, autopsies}) →
   ConfigDiff | null`. MVP mapping: category-to-weight-adjustment table (e.g.
   `POSITIONING_MISREAD → +5% to perp.positioning weight`). LLM does NOT propose weights;
   that's the deterministic engine's job (rule 13). The LLM's role ended at autopsy narrative.
5. **Backtest** — reruns change-6 seeding over a historical window with the proposed
   `ScoringConfig` and computes headline metrics. Uses M6c5's `walkForwardFolds` +
   `evaluateFold` — this is exactly what those primitives were built for.
6. **Out-of-sample confirmation** — same backtest on a HELD-OUT LATER WINDOW (§24 last
   paragraph). Only if BOTH the training and OOS windows improve does the hypothesis reach
   PROMOTED.
7. **Promotion writes a NEW `scoring_config` row** (M4's append-only versioned table). Version
   bumps; the old version stays queryable so §22 attribution can compare pre/post.
8. **`isBootstrapping` gate** — a hypothesis proposed while §32's bootstrap window is active
   goes to PROPOSED but backtest is DEFERRED until bootstrap clears. Prevents a weight change
   that only looked real on the first 30 predictions.

## Why this is the last change of M7

Every earlier change collects data (Judge, gate, shadows, autopsies) or reports on it. THIS one
edits the deterministic engine, guarded by the discipline §24 makes non-negotiable. Putting it
last means the guards (backtest, OOS, effective-n ≥ 20) can be enforced against fully populated
tables rather than fixtures.

## What this change does NOT do

- **No LLM proposes weights.** The autopsy PATTERN triggers a proposal; the specific weight
  delta comes from a code-side mapping table. Rule 13.
- **No memecoin.** §24 memecoin deferral verbatim: no backtest → no promotion path → autopsy
  hypotheses have nowhere to go.
- **No auto-promotion.** Every promoted hypothesis passes both windows; a manual
  `--force-promote` flag is not built (would be the exact "trust the LLM" pattern §24 forbids).

## Ambiguity to resolve (see design.md)

**§24 says the LLM's `recommendation` field feeds "a specific weight change (e.g. 10% → 18%)."**
Does the LLM literally propose the delta, or is that a code-side mapping? Two options:
- **A** parse `recommendation` for numeric hints and propose exactly those
- **B** ignore the numeric text; use a code-side `category → delta` table
Chosen: **B**. Parsing free-form LLM text for a specific numeric weight change would put the
LLM in the "calculation" seat rule 13 keeps it out of. The pattern (recurring category)
triggers a proposal; the size of the change is deterministic and reviewable.
