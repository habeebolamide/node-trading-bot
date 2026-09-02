# Tasks: m6-attribution-metrics

`[x]` done — **23 new tests, 511/514 suite green (4 clean runs).**

## 1. Attribution (`evaluation/src/attribution/`)
- [x] `attributionFor(predictionId)` — TWO sections: composite contributions (sum to score) and
      confidence contributions (sum to confidence). Never one flat list implying a single total
- [x] `factorPredictiveValue(domain, factor, asOf)` — conditional win rate by contribution
      tertile, Wilson on recency-weighted effective-n (reusing M5's helpers, not a second
      statistics implementation)
- [x] overlapping intervals → report "no measurable difference", never a small effect

## 2. Calibration (Task 7)
- [x] `brierScore(predictions)`
- [x] `reliabilityDiagram(predictions, bins = 10)` — per-bin effective-n + Wilson
- [x] bucketing by confidence × horizon × regime (regime read from the fingerprint dimension)

## 3. §32 metric set
- [x] accuracy, median return, benchmark-relative return, alpha, max drawdown, precision/recall
- [x] breakdowns: by horizon · by regime · by agent · by wallet cohort · by setup
- [x] every metric grouped by `configVersion`; NO all-versions aggregate accessor

## 4. Walk-forward (perp only, Task 7)
- [x] `walkForwardFolds(range, trainDays = 60, testDays = 20)` — disjoint by construction
- [x] `evaluateFold(fold, config)`
- [x] memecoin excluded (§25)

## 5. Reporting API
- [x] read-only functions returning plain rows; no HTTP, no formatting (M8 owns both)

## 6. Tests
- [x] Brier vs. hand-computed, incl. all-correct / all-wrong
- [x] reliability: calibrated set on the diagonal; overconfident set below it
- [x] tertiles: real effect → separated intervals; random factor → overlapping, reported as such
- [x] attribution sections sum to score and confidence respectively, and are not merged
- [x] version isolation; no all-versions accessor exists
- [x] folds disjoint and chronological
- [x] bootstrap: too few predictions → explicit insufficiency, not a number

## 7. Wrap-up
- [x] typecheck + full suite green
- [x] ARCHIVE + completion summary
