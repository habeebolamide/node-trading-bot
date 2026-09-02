# Change: m6-attribution-metrics

> **COMPLETED 2026-09-02.** Grows `packages/evaluation/src/metrics/` — no new package. Read-only
> queries; nothing here writes a weight (§16 descriptive-not-prescriptive extended to metrics).
>
> - `attribution.ts` — `attributionFor` returns TWO sections (composite contributions summing to
>   `score`; confidence contributions summing to `confidence`), rejecting §22's own example
>   which merges them into one column. `factorPredictiveValue` implements §22's "which factors
>   had predictive value" as **conditional win rate by contribution tertile with Wilson
>   intervals on recency-weighted effective-n** — chosen over Pearson (assumes linearity;
>   one big winner dominates a small sample) and regression (needs far more resolved predictions
>   than a bootstrap window has). Non-overlapping Wilson intervals are the reporting bar:
>   overlap → **"no measurable difference"** rather than a small effect. Reuses M5's Wilson +
>   half-life helpers so a factor's tertile stats can never disagree with a Setup Memory row
>   about how old is old.
> - `calibration.ts` — `brierScore` + `reliabilityDiagram` + `calibrationSummary` with ECE. Task
>   7 explicitly wants BOTH: Brier says how wrong on average; the diagram says WHICH DIRECTION
>   (over- vs. under-confident is a different fix). Empty bins report null; each populated bin
>   carries n + Wilson so a sparse bin is not paraded as a precise point on the curve.
> - `metrics.ts` — `headlineMetrics` (n, wins, accuracy + Wilson, mean/median return, mean alpha,
>   compounded max drawdown), `byHorizon`, `precisionRecall`, `isBootstrapping` (§32 bootstrap-
>   window signal — an explicit insufficiency marker, not a metric). Every read is grouped by
>   `configVersion` and **there is NO all-versions accessor** — a runtime test asserts no export
>   whose name matches `/allVersions|blend|combined/i` exists.
> - `walk-forward.ts` — `walkForwardFolds(domain, opts)` — disjoint train/test ranges by
>   construction (Task 7's "never tune and test on the same window" made structural).
>   `evaluateFold` reports headline metrics on the test window. **Perp only** — `memecoin` throws
>   with the §25 citation; silent skip would hide the mismatch.
>
> **Verified:** typecheck green; **511/514 tests pass** (3 opt-in live) across 4 consecutive
> full-suite runs, 23 new — pure Brier + reliability (10), pure walk-forward (6), live-DB
> attribution + metrics (7 incl. version isolation with a runtime assertion no all-versions
> reader is exported, factor separated → measurable, factor overlapping → "no measurable
> difference", bootstrap signal).
>
> **One test-fixture correction on the way through:** the initial live-DB assertions used
> `configVersion: 1` — but every fresh `tradingAgent` starts at v1 by default, so parallel test
> files' outcomes for their own v1s were leaking into my byHorizon assertion (a 1h outcome from
> the outcome-sweep integration test appeared under my perp/v1/1h query). Fixed by using
> unique high-numbered versions (500+) per test — effectively private, independent of whatever
> else is running.
>
> **What this DOES NOT do, and why:** no dashboard UI (M8; CLAUDE.md warns against drifting into
> dashboard work during M1–M6, the same rule extends through M6); no hypothesis proposal or
> promotion (§24, M7 — this change supplies the walk-forward machinery M7 will need, at the
> effective-n ≥ 10 reporting bar, NOT §24's higher ≥ 20 promotion bar); no config writes.

**Status:** COMPLETED — archived
**Original status:** PROPOSED (scoping)
**Milestone:** M6 (change 5 of 6)
**Implements:** §22 Attribution · Task 7 (calibration metrics, walk-forward, train/test) ·
§32 Success Criteria metric list · §33 rules 11, 21, 22, and "do not blend versions"

## What's changing

The measurement layer — "did any of this actually work?"

1. **Attribution** (§22) — per-prediction factor breakdown (wallet convergence +21, momentum +14,
   historical edge +9, …), computed from the contributions M4 already persists on `signal_feature`.
   After resolution, record **which factors actually had predictive value**, which §22 names as
   input to future Brain improvements.
2. **Calibration** (Task 7, first-class) — **reliability diagram + Brier score**, bucketed by
   confidence × horizon × regime. The question is literally "when we say 0.7, do we hit ~70%?"
3. **The §32 metric set** — prediction accuracy, median return, benchmark-relative return, alpha,
   max drawdown, precision/recall, and breakdowns **by horizon, by market regime, by agent, by
   wallet cohort, by setup**.
4. **Walk-forward scaffolding** (Task 7, perp only) — rolling folds of train 60d / test 20d, with
   the out-of-sample discipline that hypothesis promotion (§24, M7) will require. This change
   builds the fold machinery and the metric computation; M7 supplies the hypotheses.
5. **A reporting API** — the queries M8's dashboard will render. No UI here (that is M8, and
   CLAUDE.md warns explicitly against drifting into dashboard work during M1–M6).

## Why separate from change 4

Change 4 decides *what happened*; this change decides *what it means*. Keeping them apart means a
metric bug can never corrupt an outcome row, and the outcome resolver stays free of the
grouping/statistics surface that will churn as M8's dashboard evolves.

## What this change does NOT do

- **No dashboard UI** — M8 owns it, and CLAUDE.md: "Do not spend planning time on M8 dashboard
  while building M1–M4." The same applies through M6.
- **No hypothesis proposal or promotion** (§24) — M7. This change supplies the evaluation
  machinery those will need, at the effective-n ≥ 10 reporting bar, NOT §24's ≥ 20 promotion bar.
- **No config changes.** Nothing here writes a weight. §16's descriptive-not-prescriptive
  discipline extends to every metric in this change.

## Ambiguity to resolve (see `design.md`)

**§22 says "record which factors actually had predictive value" without defining the measure.**
Correlation? Regression coefficient? Conditional win rate? Different choices give different
answers and this number is explicitly intended to steer future Brain work, so it should not be
picked casually.
