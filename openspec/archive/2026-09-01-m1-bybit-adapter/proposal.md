# Change: m1-bybit-adapter

> **COMPLETED 2026-09-01.** Shipped `packages/ingestion` with the Bybit provider behind the
> rule-17 seam: `provider.ts` (normalized types, both clocks), `bybit/{topics,normalize,rest,ws,
> adapter,poller}.ts`, and `staleness/{thresholds,monitor}.ts` (the §10 feed-death detector).
> The adapter normalizes → persists into the change-1 historical store (confirmed candles;
> funding on-change; OI per-minute-bucketed — bounded so the sub-second ticker stream can't
> flood) → publishes `perp.kline.closed` / `perp.funding.updated` / `perp.open_interest.updated`
> / `perp.liquidation.detected`; the poller emits `perp.positioning.polled`. `apps/worker` now
> starts live ingestion for BTC/ETH/SOL across all six timeframes with a FeedMonitor check loop.
> Also closed the change-1 follow-up: `loadEnv()` (find-up dotenv) added to `@tip/domain` and
> called in both apps.
>
> **Verified:** typecheck green; **47/49 tests pass** (2 are opt-in Bybit-live, run and passing
> separately). Covered: normalization incl. ticker delta-merge, REST retCode/HTTP error split,
> FeedMonitor stale/recover with an injected clock and the exact §10 threshold values, adapter
> confirm-gate + event-rate bounding, and live-Postgres candle idempotence. Live-network checks
> done: REST klines + account-ratio against real Bybit, and a WS smoke that connected to Bybit
> mainnet and received a snapshot + a partial delta (exercising the delta-merge).
>
> **Deviations from spec:** none material. As designed, orderbook/publicTrade streams, the
> BLOCKED transition, and backfill orchestration are deferred (their milestones). One live-run
> fix beyond spec: `subscribe()` is gated on socket-open to avoid a spurious "send while
> CONNECTING" warning (the open handler resubscribes anyway).
>
> **Follow-ups:** none blocking. Next: `m1-helius-adapter` (needs `HELIUS_API_KEY`).

**Status:** COMPLETED — archived
**Original status:** PROPOSED (building straight through)
**Milestone:** M1 — Data Foundation (§30), change 2 of 4
**Implements:** Part III §5 (Bybit provider), §12 (normalization boundary), §17 (provider
adapter rule), §10 (event architecture, event-time/processing-time, feed staleness), §25
(historical store = live store, one table). §33 rules 8/17/19.

## Why

M1's goal is "raw external data becomes clean internal events." `m1-foundation-core` built the
spine; this change plugs in the first real feed: **Bybit** perp market data. Everything
Bybit-specific stays behind a provider adapter (rule 17) — downstream only ever sees normalized
domain events (§12). Closed candles, funding and OI persist into the historical store built in
change 1, which is the same table live ingestion extends and the replay engine (change 4) will
read (§25).

This change also builds the **feed-staleness detector** (§10) — "the specific bug that killed
the previous bot." A silently-dead WebSocket must be noticed, not ignored.

## What changes

New package **`packages/ingestion`** (grows again in change 3 for Helius):

- **`provider.ts`** — the domain-facing `MarketDataProvider` interface + the normalized types
  (`NormalizedKline`, `NormalizedTicker`, `NormalizedLiquidation`, `NormalizedAccountRatio`).
  This is the seam rule 17 protects; nothing below imports Bybit types.
- **`bybit/`** — `topics.ts` (topic builders + Timeframe↔Bybit-interval mapping), `normalize.ts`
  (pure raw→normalized functions, heavily unit-tested), `rest.ts` (`BybitRestClient`: historical
  klines, funding history, OI history, account-ratio poll — all timeout-guarded), `ws.ts`
  (`BybitWsClient`: connect, subscribe, 20s ping, auto-reconnect+resubscribe), `adapter.ts`
  (`BybitAdapter`: wires WS+poll → normalize → persist + publish).
- **`staleness/`** — `thresholds.ts` (the §10 table as infra config, tunable) + `monitor.ts`
  (`FeedMonitor`: per-feed heartbeat/watermark, threshold check, stale→recover transitions with
  an injectable clock).

Wiring: `apps/worker` starts Bybit ingestion for the MVP symbol set (BTCUSDT/ETHUSDT/SOLUSDT,
§30) across the style-relevant timeframes; the positioning poll runs on its own cadence.

Events emitted (all §10 names, already declared in `@tip/events`):
`perp.kline.closed` · `perp.funding.updated` · `perp.open_interest.updated` ·
`perp.liquidation.detected` · `perp.positioning.polled`.

Persistence: confirmed closed candles → `market_candle`; funding → `funding_rate`; OI →
`open_interest`. All upserts idempotent (re-delivery / reconnect replay safe, §29).

## What this change does NOT do

- **No orderbook / publicTrade streams** — their only consumer is the tick monitor (§10),
  which is a later milestone. Subscribing now would be dead data. The staleness table keeps
  their thresholds for when they land.
- **No backfill orchestration** — `BybitRestClient` exposes the historical fetch methods, but
  the backfill *script* that walks history into Postgres is change 4 (`m1-replay-engine`).
- **No BLOCKED transition** — `FeedMonitor` detects and reports staleness; wiring a stale feed
  to transition dependent TradingAgents to BLOCKED (§37) needs TradingAgents, which don't exist
  until M4. For now staleness is logged + exposed as state.
- **No basis/volatility** — derived downstream from data already ingested (§5), not fetched.
- No agents, signals, scoring.

## Resolved solo (flag)

- Bybit v5 linear public WS (`/v5/public/linear`), REST base `api.bybit.com`; `BYBIT_TESTNET`
  switches both to testnet hosts. Public data only — no signing (keyless), per §5.
- MVP watch set is a code constant (`DEFAULT_PERP_SYMBOLS`) with a comment, not env — it's
  operational infra config, promotable to a table later.
- `ws` chosen as the WebSocket client (tiny, standard). Justified dependency (design.md).
