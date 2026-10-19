# Phase 2 — Market data infrastructure

## Delivered

`packages/market-data` defines `MarketDataProvider`, `CandleRepository`, `DataRequirements`, `Candle`, `Instrument`, `FeedEvent` and `PriceEvent`. Dependencies are injected; no authenticated exchange API or order submission exists. All financial fields stay decimal strings until the explicit indicator conversion boundary.

- Bybit public REST validates live instrument identity/status and spot versus linear-perpetual contract type, caches expiring specifications, retains immutable specification versions, and fetches native OHLCV with bounded reverse pagination. Queries set category and interval explicitly. Each response is schema checked; HTTP calls have timeouts and bounded retries.
- PostgreSQL stores independent closed-candle series, coverage gaps, health and per-series checkpoints. UTC open times are aligned to each timeframe; close times are **exclusive**. Both application validation and SQL constraints reject open/inconsistent candles. Duplicate storage is idempotent and cannot regress a checkpoint. Closed candles and specification versions are immutable. Conflicting source revisions fail closed and require review instead of silently rewriting prior decision inputs.
- One public WebSocket per market category shares reference-counted price/candle topics. Subscription acknowledgments, unsubscribe acknowledgments, heartbeat timeout, rejected/malformed messages and reconnect/resubscribe are handled. Only `confirm: true` candles are sealed. Prices use exchange trade IDs, timestamps, side and LAST-trade reference; no assumption that LAST is an executable bid/ask or mark price.
- `MarketDataService.seed(market, requirements)` seeds only missing native ranges and shares concurrent requests. Counts derive from explicit timeframe requirements and indicator stability requirements; indicator-only frames default to an illustrative 500 bars. Supported frames: 1m, 5m, 15m, 1h, 4h. A single seed request is bounded to 10,000 bars per timeframe.
- Native **TA-Lib 1.1.6**, pinned for Node 22, calculates SMA, EMA, RSI, ATR, ADX, MACD and Bollinger Bands. A local C/C++ toolchain, Python and make are required for installation; the npm package builds its bundled TA-Lib. `createRequire` loads its native CommonJS binding from ESM. No JavaScript approximation replaces TA-Lib. Adapter output records engine version and input cutoff.
- Readiness requires complete latest native candle coverage, current instrument specifications, an acknowledged live subscription, a fresh heartbeat and verified coverage after reconnect. Source/consumer integrity faults block evaluation. Price consumers remain independent of history repair/database queues; duplicate IDs are suppressed in a bounded live cache and late events are explicitly tagged. This is input readiness for future candle strategies, **not authorization to trade**.
- Runtime supports an optional research watchlist and periodically repairs coverage. Bot startup and strategy-owned requirements connect in Phases 3–4. It remains an independently supervised process and never claims trading readiness. The API exposes authenticated `GET /api/market-data/health`; persisted projections expire after 15 seconds so a dead runtime cannot report READY indefinitely.

## Run

```sh
nvm use
npm ci
npm run db:migrate
npm run market:seed -- --base BTC --quote USDT --type LINEAR_PERPETUAL --timeframes 5m,1h --count 500
```

The CLI persists candles and prints data health. Missing coverage sets a nonzero exit code. `canEvaluate` also requires a confirmed WebSocket subscription; a fast one-shot seed may finish before the handshake. Continuous subscriptions and monitoring belong to the runtime:

```sh
MARKET_DATA_WATCHLIST='[{"market":{"exchange":"bybit","marketType":"LINEAR_PERPETUAL","baseAsset":"BTC","quoteAsset":"USDT"},"minClosedCandlesByTimeframe":{"5m":500,"1h":500}}]' npm run dev:runtime
```

Or put that JSON value in `.env`. Default watchlist is empty; no market is silently assigned to a bot. Runtime repair defaults to 5 seconds and heartbeat freshness to 65 seconds, configured with `MARKET_REPAIR_INTERVAL_MS` and `MARKET_HEARTBEAT_MAX_AGE_MS`. Keep repair intervals at 5 seconds or less for the current 15-second API projection expiry. A quiet market is assessed using transport heartbeat, not absence of trades alone. Runtime liveness is `/health/live` on port 3001; `/health/ready` stays 503 until the trading runtime exists.

`calculateIndicator(candles, request, decisionTime)` requires contiguous, sufficiently warmed, single-market/single-timeframe inputs whose close/availability times do not exceed the decision timestamp. It rejects missing most-recent completed candles and unfinished higher-timeframe input. Recursive warmups are documented engineering heuristics (6 periods, 12 for ADX; MACD slow-period warmup plus signal period), configurable upward, not evidence of strategy profitability. Phase 3 supplies versioned strategy presets.

## Recovery and limits

A missing candle range is persisted before fetch and resolved only after coverage verification. Checkpoints commit in the same transaction as their stored candles; a last-stored checkpoint does not imply uninterrupted historical coverage. Reconnect resets evaluation readiness until the history pass succeeds.

Public trade-stream interruptions are retained as `PUBLIC_TRADES` gaps with **UNCERTAIN** status. Candle repair never marks missing tick ordering as proven. Provider capability explicitly declares `RECENT_ONLY` trade history and `completeRangeReplay: false`; arbitrary-range historical trade replay, durable tick archives and reconciliation of positions are Phase 6 work. No inferred fills or optimistic TP/SL ordering exist in this phase. A future open-exposure runtime must resolve those execution uncertainties before enabling entries.

REST historical candles have their actual ingestion time as `availableAt`; database queries cannot expose them to a decision predating ingestion. This deliberately prevents retroactive live signals. Historical dataset availability rules and immutable run manifests will be explicit in Phase 6. Native indicator floats are used only for analysis; persistent prices/amounts remain NUMERIC(38,18). No automatic correction/version replacement workflow is provided yet. Operator review of a conflicting closed candle must preserve its evidence.

The bounded 10,000-ID live price cache is not durable exactly-once execution processing. Trade/order/evaluation idempotency remains a database responsibility in subsequent phases. Numeric time values are safe integer UTC milliseconds; source event and ingestion times remain distinct. HTTP transport retries are bounded; WebSockets reconnect with capped exponential backoff. Regional exchange access failures remain degraded and do not fall back to fabricated data.

## Evidence and phase gate

Commands:

- `npm run check`: typecheck, unit/protocol tests, real PostgreSQL/process tests and production build.
- `npm run db:migrate`: additive market schema and immutable-data migrations on native PostgreSQL 17.
- `npm run db:generate`: verify no schema drift after migrations.
- `npm run format:check` and `npm audit`.

Deterministic fixtures exercise independent 500-bar 5m/1h series, correct closed higher-timeframe selection, coverage gaps and targeted repair, duplicates, invalid/open candles, reverse pagination, shared actual local WebSocket topics, acknowledgments, reconnect/resubscribe, native TA-Lib golden SMA and all supported indicators, stale transport, late trades, failing consumers, immutable revisions and correction faults. PostgreSQL tests verify durable gap resolution, uncertain trade interruption evidence, checkpoint restoration/non-regression and SQL-level closed-candle constraints. Existing Phase 1 authorization, allocation, ownership and process-isolation gates remain required.

**Final automated result:** 22 unit/protocol tests and 13 PostgreSQL/process integration tests pass (35 total). Type checking, production builds and formatting pass. Migration generation reports no schema drift; `npm audit` reports zero vulnerabilities.

Live smoke checks against public Bybit succeeded without credentials: native 5m and 1h histories each reached **500 complete candles** with zero missing bars; the public WebSocket acknowledged subscriptions, delivered trade events and reported data READY. These checks are supplementary; automated tests use controlled fixtures/local servers and never require external availability.

No strategy execution, orders, positions or trade accounting are enabled. Phase 3 is next.

## Protocol references

- [Bybit historical klines](https://bybit-exchange.github.io/docs/v5/market/kline)
- [Bybit instrument specifications](https://bybit-exchange.github.io/docs/v5/market/instrument)
- [Bybit public trade stream](https://bybit-exchange.github.io/docs/v5/websocket/public/trade)
- [Bybit closed-candle stream](https://bybit-exchange.github.io/docs/v5/websocket/public/kline)
- [Bybit WebSocket connection protocol](https://bybit-exchange.github.io/docs/v5/ws/connect)
- [Native Node TA-Lib binding](https://github.com/oransel/node-talib)
