# Change: m4-perp-agents

**Status:** PROPOSED (scoping)
**Milestone:** M4 — Agent Swarm (§30), change 4 of 5
**Implements:** §40.1 Perp Momentum, §40.2 Open Interest, §40.3 Market Regime, §40.4
Liquidation, §40.5 Funding, §40.6 Positioning, §40.15 Volume feature, §40.16 Historical Edge
feature (stub — real edge in M5). Part III §3 (perp composite). §33 rules 13, 17, 23.
**Depends on:** m4-tradingagent, m4-signal-engine, M1 Bybit adapter (data source).

## Why

Ships the **perp agent roster** end-to-end. Consumes the Bybit ingestion already running (M1)
— candles, funding, OI, liquidations, positioning polls — and produces the six per-agent
outputs the Signal Scoring Engine composes into a perp signal. Once this lands, `POST
/trading-agents` for a perp agent (say "BTC Perp Scout" from §8's example) turns live Bybit
data into per-timeframe signals.

## What changes

`packages/agents` grows a `perp/` subtree:

- **`perp/momentum.ts`** — §40.1 CADENCE+CONDITIONAL on primary-TF close (§8 style mapping);
  EMA(9,21,50) alignment + EMA(21) slope + RSI(14) + MACD(12,26,9); dead-candle skip.
- **`perp/open-interest.ts`** — §40.2 CADENCE on primary-TF close; 4-candle price×OI delta
  → 2×2 matrix `{TREND_CONFIRM_BULL | SHORT_COVERING | NEW_SHORTS_BEAR | LONG_UNWIND}`.
- **`perp/market-regime.ts`** — §40.3 CADENCE on primary-TF close; ADX(14) + higher-TF
  EMA(50) slope + ATR ratio → enum `{BULL | BEAR | RANGE | HIGH_VOL}` + directional bias.
  Broadcasts `perp.regime.classified` so downstream agents that condition on regime can subscribe.
- **`perp/liquidation.ts`** — §40.4 EVENT (`perp.liquidation.detected`) + CADENCE roll-up on
  primary-TF close; imbalance + intensity → contrarian score with sign flip.
- **`perp/funding.ts`** — §40.5 CADENCE on primary-TF close; funding percentile within
  rolling 30-day distribution → symmetric contrarian.
- **`perp/positioning.ts`** — §40.6 CADENCE on positioning-poll event
  (`perp.positioning.polled`); L/S ratio percentile → symmetric contrarian.
- **`perp/features/volume.ts`** — §40.15 aggregator-only feature: 10-candle volume-signed
  direction on primary TF.
- **`perp/features/historical-edge-stub.ts`** — §40.16 stub returning `INSUFFICIENT`
  (real read of `BrainSetupMemory` lands in M5).

Each agent carries `agentVersion` (integer, bumped only on behavioral change per Task 1).
Registered with the framework built in change 2 so triggers fire per §7 taxonomy.

Rolling-buffer infrastructure: a small `market-buffers.ts` maintains per-symbol OHLCV, ticker,
funding, OI, liquidation, and account-ratio buffers over primary TF + higher TF (up to what
each agent needs). Fed from the M1 event stream.

## What this change does NOT do

- **No Risk Agent** — change 5 adds it as the post-aggregation gate.
- **No Judge / LLM (§40.14)** — M7. Perp Judge fires *after* composite, so composite without
  Judge is valid M4 output; §18 memecoin note says perp Judge FLIP is the driver of the
  override machinery, but that whole layer waits until M7.
- **No BrainSetupMemory writes** — M5. Historical Edge feature returns `INSUFFICIENT`.
- No Prediction / Paper Engine — M6.

## Resolved solo (flag)

- **Rolling buffers use in-memory Maps per worker instance**, seeded from the historical store
  on TradingAgent start; a restart re-seeds. Persistent per-symbol state is a later refinement.
- The 30-day rolling funding/positioning history is queried lazily from the DB on first agent
  fire per symbol, then cached in the buffer.
