# Change: m6-attribution-metrics

**Status:** PROPOSED (scoping)
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
