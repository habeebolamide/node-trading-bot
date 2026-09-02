# Tasks: m6-attribution-metrics

## 1. Attribution (`evaluation/src/attribution/`)
- [ ] `attributionFor(predictionId)` — TWO sections: composite contributions (sum to score) and
      confidence contributions (sum to confidence). Never one flat list implying a single total
- [ ] `factorPredictiveValue(domain, factor, asOf)` — conditional win rate by contribution
      tertile, Wilson on recency-weighted effective-n (reusing M5's helpers, not a second
      statistics implementation)
- [ ] overlapping intervals → report "no measurable difference", never a small effect

## 2. Calibration (Task 7)
- [ ] `brierScore(predictions)`
- [ ] `reliabilityDiagram(predictions, bins = 10)` — per-bin effective-n + Wilson
- [ ] bucketing by confidence × horizon × regime (regime read from the fingerprint dimension)

## 3. §32 metric set
- [ ] accuracy, median return, benchmark-relative return, alpha, max drawdown, precision/recall
- [ ] breakdowns: by horizon · by regime · by agent · by wallet cohort · by setup
- [ ] every metric grouped by `configVersion`; NO all-versions aggregate accessor

## 4. Walk-forward (perp only, Task 7)
- [ ] `walkForwardFolds(range, trainDays = 60, testDays = 20)` — disjoint by construction
- [ ] `evaluateFold(fold, config)`
- [ ] memecoin excluded (§25)

## 5. Reporting API
- [ ] read-only functions returning plain rows; no HTTP, no formatting (M8 owns both)

## 6. Tests
- [ ] Brier vs. hand-computed, incl. all-correct / all-wrong
- [ ] reliability: calibrated set on the diagonal; overconfident set below it
- [ ] tertiles: real effect → separated intervals; random factor → overlapping, reported as such
- [ ] attribution sections sum to score and confidence respectively, and are not merged
- [ ] version isolation; no all-versions accessor exists
- [ ] folds disjoint and chronological
- [ ] bootstrap: too few predictions → explicit insufficiency, not a number

## 7. Wrap-up
- [ ] typecheck + full suite green
- [ ] ARCHIVE + completion summary
