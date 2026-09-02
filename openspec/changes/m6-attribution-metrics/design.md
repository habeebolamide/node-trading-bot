# Design: m6-attribution-metrics

## Where it lives

Grows `packages/evaluation`. §28 assigns it "backtest replay, outcome resolution, metrics."

## Attribution — the per-prediction breakdown (§22)

Each prediction already stores its contributions (`signal_feature`: score, confidence, features
per `(agentKey, agentVersion)`), and `composeSignal` already returns per-agent
`{ weight, contribution }`. So the §22 display table is a projection of data that exists:

```
Prediction #8321
  Wallet convergence  +21     ← weight × score, renormalized, scaled to the display total
  Wallet quality      +18
  Momentum            +14
  Agent agreement     +11     ← from the confidence layer, not an agent
  Historical edge      +9
  Liquidity            +6
                      ---
  Total                79
```

Note two rows in §22's own example are **not agents**: "agent agreement" is a confidence
sub-metric and "liquidity" is a data-quality/feature input. The breakdown therefore has two
sections — composite contributions (which sum to the score) and confidence contributions (which
sum to the confidence) — rather than one flat list that would imply they add to the same total.
Flagged because §22's example presents them as one column.

## Ambiguity — "which factors actually had predictive value"

§22 gives no measure. Candidates and why they fail or fit:

| Measure | Verdict |
|---|---|
| Pearson correlation of contribution vs. return | Rejected — assumes linearity, and one big winner dominates a small sample. |
| Regression coefficients over contributions | Rejected for MVP — needs far more resolved predictions than a bootstrap window has, and an under-determined fit produces confident nonsense. |
| **Conditional win rate by contribution tertile, with Wilson intervals** | **Chosen.** |

**Chosen: conditional win rate by contribution tertile.** For each factor, bucket its resolved
predictions into low/med/high contribution and compare win rates with Wilson intervals on
recency-weighted effective-n. "When Momentum contributed a lot, did we win more than when it
contributed little?" is exactly §22's question, and it is answerable at bootstrap sample sizes.

Why it fits this codebase specifically: it reuses the tertile bucketing and the Wilson-on-
effective-n machinery M5 already built and tested, rather than introducing a second statistical
vocabulary. §41's "one tested function, everywhere" argument applies.

**Non-overlapping intervals are the reporting bar.** A factor whose high-tertile and low-tertile
Wilson intervals overlap is reported as "no measurable difference" — not as a small effect. This
is the same explicit-insufficiency discipline Part II §8 applies to Setup Memory, and it is what
stops a bootstrap-window sample from generating confident-sounding steering.

## Calibration (Task 7 — first-class, not an afterthought)

```
Brier score        = mean((confidence − outcome)²) over resolved predictions
Reliability diagram= confidence bucketed (10 bins) vs. observed win rate per bin,
                     with per-bin effective-n and Wilson intervals
Buckets            = confidence × horizon × regime  (Task 7's stated slicing)
```

Regime comes from the setup fingerprint's regime dimension — already stored, no new derivation
(the same "regime requires no separate handling" argument M5's Market Memory used).

A Brier score alone is not enough and Task 7 asks for both: Brier says how wrong, the reliability
diagram says *which direction* — systematically overconfident is a different fix from
systematically underconfident.

## Version discipline

Every metric is grouped by `configVersion` by default, and the API has **no "all versions"
aggregate**. CLAUDE.md: "Silently blending track records across versions destroys the 'did this
change actually help' question." Same reasoning as M5's refusal to roll up agent versions. A
caller wanting a blended number must union explicitly, which makes the choice visible in the
calling code.

## Walk-forward (Task 7, perp only)

Rolling folds: train 60d / test 20d, stepped forward. This change builds `walkForwardFolds(range)`
and `evaluateFold(fold, config)`; M7's hypothesis pipeline consumes them. **Never tune and test on
the same window** — the fold generator returns disjoint train/test ranges by construction, so a
caller cannot accidentally overlap them.

Memecoin is excluded: §25 scopes memecoin out of historical backtest entirely.

## Reporting API

Read-only query functions returning plain data — no HTTP layer, no formatting. M8 adds the
endpoints and the UI. Keeping the boundary at "functions returning rows" means the dashboard's
churn never reaches the statistics.

## Testing

- Brier score against hand-computed values, including the degenerate all-correct / all-wrong cases.
- Reliability bins: a perfectly calibrated synthetic set lands on the diagonal; a systematically
  overconfident set lands below it.
- Attribution tertiles: a factor with a genuine effect shows separated intervals; a random factor
  shows overlapping intervals and is reported as "no measurable difference."
- Attribution sections sum correctly: composite contributions to the score, confidence
  contributions to the confidence — and a test that they are NOT presented as one total.
- Version isolation: metrics for v1 and v2 never merge; no all-versions accessor exists.
- Walk-forward folds are disjoint and chronological; a train window never overlaps its test window.
- Empty/bootstrap behaviour: with too few resolved predictions every metric reports insufficiency
  explicitly rather than a number — the state the system will actually be in on day one.
