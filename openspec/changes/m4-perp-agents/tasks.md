# Tasks: m4-perp-agents

`[ ]` todo · `[x]` done (SCOPING — depends on changes 1 & 2; runs alongside change 3)

## 1. Buffers + registration
- [ ] `perp/market-buffers.ts` — rolling in-memory buffers per symbol, seeded from historical
      store, updated on each M1 event
- [ ] `perp/index.ts` — register all 6 agents + 2 features with the trigger router

## 2. Perp agents (6)
- [ ] `perp/momentum.ts` (§40.1) — EMA(9,21,50) + slope + RSI(14) + MACD; dead-candle skip
- [ ] `perp/open-interest.ts` (§40.2) — 4-candle Δp×ΔOI 2×2 quadrant
- [ ] `perp/market-regime.ts` (§40.3) — ADX + higher-TF slope + ATR; enum + bias; broadcasts perp.regime.classified
- [ ] `perp/liquidation.ts` (§40.4) — imbalance + intensity, contrarian sign flip, EVENT + CADENCE roll-up
- [ ] `perp/funding.ts` (§40.5) — 30d percentile → symmetric contrarian
- [ ] `perp/positioning.ts` (§40.6) — on perp.positioning.polled, 30d percentile → contrarian

## 3. Features
- [ ] `perp/features/volume.ts` (§40.15) — 10-candle volume-signed direction
- [ ] `perp/features/historical-edge-stub.ts` (§40.16) — INSUFFICIENT stub

## 4. Tests
- [ ] unit per agent (6 × ≥3 cases each = ≥18)
- [ ] unit: features (volume boundaries, edge-stub returns INSUFFICIENT)
- [ ] integration (live DB): kline close → agents fire → aggregator → signal row

## 5. Wrap-up
- [ ] typecheck + suite green; ARCHIVE + summary
