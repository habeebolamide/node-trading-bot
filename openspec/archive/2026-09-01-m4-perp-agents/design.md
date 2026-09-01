# Design: m4-perp-agents

Read §40.1–§40.6, §40.15, §40.16, Part III §3 alongside.

## Package layout

`packages/agents/perp/` — six agents + two features. Reuses `common/trigger-router.ts` from
change 3.

## Rolling buffers (`perp/market-buffers.ts`)

Per-symbol in-memory rolling state, seeded from the historical store on TradingAgent start:

```
MarketBuffer per symbol:
  ohlcv:      Map<Timeframe, RingBuffer<Candle>>   (per TF)
  ticker:     latest merged ticker snapshot
  funding:    ring buffer, 30d rolling (for percentile)
  oi:         ring buffer, last 4 primary candles + rolling 30 for volatility
  liquidation: ring buffer, last 3 primary candles (windowed)
  positioning: last N successful polls + 30d percentile
```

Buffers advance on each M1 event (`perp.kline.closed`, `perp.funding.updated`,
`perp.open_interest.updated`, `perp.liquidation.detected`, `perp.positioning.polled`).

## Agents (each matches its §40.x spec verbatim)

- **momentum** (§40.1) CADENCE+CONDITIONAL — EMA(9,21,50) + slope + RSI(14) + MACD(12,26,9)
- **open-interest** (§40.2) CADENCE — 4-candle Δ price × Δ OI → 2×2 quadrant
- **market-regime** (§40.3) CADENCE — ADX + higher-TF slope + ATR ratio → BULL/BEAR/RANGE/HIGH_VOL
  + directional bias; broadcasts `perp.regime.classified`
- **liquidation** (§40.4) EVENT + CADENCE roll-up — imbalance + intensity, contrarian sign flip
- **funding** (§40.5) CADENCE — funding percentile in rolling 30d → symmetric contrarian
- **positioning** (§40.6) CADENCE on `perp.positioning.polled` — L/S percentile → contrarian

## Features

- **volume** (§40.15) — 10-candle volume-signed direction, aggregator-only
- **historical-edge-stub** (§40.16) — returns `INSUFFICIENT` at M4 (real BrainSetupMemory read
  arrives in M5)

## Trigger routing

```
router.onCandleClose(primaryTf, momentum, marketRegime, funding, openInterest, liquidation);
router.on(EVENT_NAMES.PERP_LIQUIDATION_DETECTED, liquidation);
router.on(EVENT_NAMES.PERP_POSITIONING_POLLED, positioning);
```

Volume + historical-edge-stub are features (not triggered), pulled into the aggregator's
snapshot at flush time.

## Testing

Unit (fixture inputs, no live network):
- momentum: EMA alignment (bull / bear / mixed), slope thresholds, RSI OB/OS, MACD sign,
  dead-candle skip, insufficient buffer
- open-interest: each of 4 quadrants + neutral flat
- market-regime: ADX below/above 20, high vol override, enum + bias correctness
- liquidation: cascade+intensity → sign flip; intensity-only → RISK_FLAG NEUTRAL
- funding: percentile boundaries (< 10, 10–25, 25–75, 75–90, > 90); insufficient history caps
- positioning: same as funding shape

Integration (live DB): seed a `perp.kline.closed` event → several perp agents fire → aggregator
flushes → signal row created (via change 2)
