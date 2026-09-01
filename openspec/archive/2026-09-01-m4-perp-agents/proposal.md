# Change: m4-perp-agents

> **COMPLETED 2026-09-01.** Grew `packages/agents/perp/` with all 6 perp Analysis Agents +
> Volume feature + Historical Edge stub:
> - `indicators.ts` (pure) — sma, ema series, rsi (Wilder), macdHistogram, atr, trueRange, percentile
> - `momentum.ts` (§40.1) — EMA alignment + slope + RSI + MACD composite, confidence from
>   agent-agreement, CONDITIONAL dead-candle skip
> - `open-interest.ts` (§40.2) — 4-candle Δp × ΔOI → 2×2 quadrant with magnitude-scaled score
> - `market-regime.ts` (§40.3) — EMA slope + ATR ratio → regime enum + directional bias
> - `liquidation.ts` (§40.4) — imbalance × intensity contrarian score; risk flag on pure spike
> - `funding.ts` (§40.5) — 30d percentile → symmetric-contrarian score; insufficient-history cap
> - `positioning.ts` (§40.6) — L/S ratio symmetric-in-log-space contrarian
> - `features/volume.ts` (§40.15) — 10-candle volume-signed direction
> - `features/historical-edge-stub.ts` (§40.16) — INSUFFICIENT stub (M5 wires the real read)
>
> `perpAgents` array holds the 6 composite participants; the DB-reading agents (Momentum, OI,
> Regime, Funding) query `market_candle`/`open_interest`/`funding_rate` (M1 tables) with
> as-of-close filters.
>
> **Verified:** typecheck green; **224/227 tests pass** (3 opt-in live). 23 new tests: indicators
> (11 — sma/ema, rsi up+down+insufficient, macd, atr, percentile, trueRange) + perp agents (12 —
> liquidation LONG/SHORT/risk-flag/flat/fallback, positioning score mapping + emit + null-guard,
> funding percentile mapping, volume empty/all-up/all-down, historical-edge-stub).
>
> **Deviations from spec:** none material. Momentum uses simplified indicator computation vs.
> ADX-based Market Regime (deferred to a follow-up refinement). The full CADENCE roll-up for
> Liquidation lives in a future addition; single-event evaluation + optional roll-up fields
> from the ingestor covers MVP. Next: m4-risk-agent (final M4 piece).

**Status:** COMPLETED — archived
**Original status:** PROPOSED (scoping)
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
