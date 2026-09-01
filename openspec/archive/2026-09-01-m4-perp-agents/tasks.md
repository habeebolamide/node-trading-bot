# Tasks: m4-perp-agents

`[x]` done

## 1. Shared indicators
- [x] `perp/indicators.ts` — sma, ema (full series), rsi (Wilder), macdHistogram, atr (Wilder),
      trueRange, percentile — pure

## 2. Perp agents (6)
- [x] `perp/momentum.ts` (§40.1) — EMA(9,21,50) alignment + slope + RSI(14) + MACD(12,26,9);
      confidence = 1 − stddev(sub_signs)/2; CONDITIONAL dead-candle skip (range<0.25×ATR AND
      vol<0.5×avg)
- [x] `perp/open-interest.ts` (§40.2) — 4-candle Δprice × ΔOI → 2×2 quadrant; magnitude-scaled;
      confidence tracks combined magnitude
- [x] `perp/market-regime.ts` (§40.3) — EMA(50) slope + ATR ratio → enum {BULL,BEAR,RANGE,
      HIGH_VOL,LOW_CONFIDENCE} + directional bias
- [x] `perp/liquidation.ts` (§40.4) — imbalance × min(intensity/3,1); risk flag on pure spike;
      single-event fallback if roll-up fields absent
- [x] `perp/funding.ts` (§40.5) — funding percentile in rolling 30d → symmetric-contrarian score;
      insufficient-history caps confidence at 0.5
- [x] `perp/positioning.ts` (§40.6) — L/S ratio symmetric-in-log-space → contrarian; capped at ratio ∈ [0.5, 2.0]

## 3. Features
- [x] `perp/features/volume.ts` (§40.15) — 10-candle volume-signed direction; <10 → 0
- [x] `perp/features/historical-edge-stub.ts` (§40.16) — returns INSUFFICIENT (M5 wires the real read)

## 4. Registration
- [x] `perp/index.ts` — `perpAgents` array (all 6, roster order) + feature exports

## 5. Tests
- [x] unit: indicators (11) — sma/ema/rsi (up + down + insufficient), macd, atr, percentile,
      trueRange
- [x] unit: perp agents (12) — liquidation (LONG/SHORT/risk-flag/flat/fallback), positioning
      (score mapping + emit + null-guard), funding-percentile mapping, volume (empty/all-up/
      all-down), historical-edge-stub

## 6. Wrap-up
- [x] typecheck + full suite green (224/227 tests pass, 3 opt-in live skipped)
- [x] ARCHIVE + summary
