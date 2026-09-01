# Design: m1-bybit-adapter

References the plan by section. Read Part III §5 and §10 alongside.

## The provider seam (rule 17)

```
Bybit WS/REST (raw)  →  bybit/normalize.ts  →  NormalizedX  →  adapter  →  { DB write, bus.publish }
                        └────────── packages/ingestion/bybit ──────────┘
downstream (events, agents, replay) only ever sees Normalized* + DomainEvents — never a Bybit shape.
```

`MarketDataProvider` (provider.ts) is the interface downstream could depend on if a second
exchange is ever added; `BybitAdapter` implements it. The normalized types carry both clocks
(§10): `eventTime` from the Bybit payload's own timestamp, `processingTime` stamped on receipt.

## Timeframe ↔ Bybit interval

```
1m→"1"  5m→"5"  15m→"15"  1h→"60"  4h→"240"  1d→"D"
```
`topics.ts` owns this map both ways plus the topic builders:
`kline.{iv}.{sym}` · `tickers.{sym}` · `liquidation.{sym}` (orderbook/publicTrade builders
exist but are not subscribed this change).

## Normalization (pure, the tested core)

`normalize.ts` exports pure functions raw→normalized, no I/O:

- **kline**: Bybit pushes an array; each entry has `start`, `end`, OHLC, `volume`, `turnover`,
  and **`confirm`** (true only on close). The adapter persists/emits **only `confirm: true`**
  (§25 seeded-outcome integrity depends on closed candles; a forming candle must never land in
  `market_candle`). `NormalizedKline` keeps `confirm` so the adapter can gate.
- **ticker**: the `tickers.{sym}` stream is the single source for both funding and OI (§5).
  One raw ticker fans out to a `NormalizedTicker` carrying `fundingRate`, `openInterest`,
  `nextFundingTime`, mark/index/last price. The adapter derives two persisted rows + two events
  from it. Bybit ticker deltas are partial — the adapter keeps a per-symbol last-known snapshot
  and merges, so a delta that omits funding doesn't erase it.
- **liquidation**: `{ symbol, side, size, price, time }` → `NormalizedLiquidation`.
- **accountRatio** (REST): `{ buyRatio, sellRatio, timestamp }` → `NormalizedAccountRatio`.

Numbers stay strings end-to-end (precision, matching the `numeric` schema columns) except where
math is needed.

## Persistence (idempotent)

- `market_candle`: `insert(...).onConflictDoNothing()` on the composite PK — reconnect replay of
  the same closed candle is a no-op. Live and backfill write the same table (§25).
- `funding_rate` / `open_interest`: `onConflictDoNothing()` on their `(symbol, time)` PKs. Time
  key = `nextFundingTime` for funding (dedupes the ~8h cadence), the ticker receipt time bucketed
  for OI (OI has no native stamp on the stream — use the ticker's `ts`).

Writes go through the normal `@tip/database` client (not `withIdempotency` — these aren't
queue-consumer effects; the DB unique constraint is the idempotency here, §29).

## WS client (ws.ts)

`BybitWsClient` responsibilities, deliberately narrow:
- connect to the linear public endpoint; on open, send the batched `{op:"subscribe", args:[...]}`.
- **ping every 20s** (`{op:"ping"}`) — Bybit closes idle sockets otherwise.
- **auto-reconnect** with capped exponential backoff; on reconnect, resubscribe the full arg set.
- surface messages via an `onMessage(topic, data)` callback and connection state via
  `onStateChange`. It does not normalize or persist — that's the adapter's job (single
  responsibility, and it keeps ws.ts fakeable in tests).

Errors: a dropped socket is a `RetryableError` condition handled by reconnect, never swallowed
(§10 — a silently-dropped message is the exact failure staleness detection exists to catch).

## REST client (rest.ts)

`BybitRestClient` over global `fetch`, every call `AbortController`-timeout-guarded (CLAUDE.md):
- `getKlines(symbol, timeframe, {start, end, limit})` — paginated historical (change 4 uses this).
- `getFundingHistory(symbol, {start, end, limit})`.
- `getOpenInterest(symbol, intervalTime, {start, end, limit})`.
- `getAccountRatio(symbol, period)` — long/short ratio, the polled lane (§5).
Response envelope is Bybit's `{ retCode, retMsg, result: { list } }`; a non-zero `retCode`
throws a typed error. Parsing is a pure step reusing `normalize.ts`.

## Positioning poll

`AccountRatioPoller` calls `getAccountRatio` on an interval (default 5m — Bybit's own refresh)
per symbol, emits `perp.positioning.polled`, and feeds the FeedMonitor a heartbeat keyed
`bybit.positioning_poll`. A failed poll does NOT heartbeat, so the 3×-interval threshold trips.

## FeedMonitor (staleness/monitor.ts) — §10

- `thresholds.ts` holds the §10 table verbatim (ms), keyed by feed id
  (`bybit.tickers`, `bybit.kline.1m`, …, `bybit.liquidation`, `bybit.positioning_poll`,
  `helius.wallet_webhook`), with the `2×interval+30s` kline rule encoded as data. Infra config,
  tunable, NOT `ScoringConfig`.
- `FeedMonitor.heartbeat(feedId)` stamps last-seen (injected `now()` for determinism/tests).
- a periodic `check()` (or on-demand) compares `now − lastSeen` to the threshold; crossing it
  fires `onStale(feedId)` once; the next heartbeat fires `onRecover(feedId)` once. State is
  queryable (`isStale(feedId)`, `snapshot()`), so `/health` and a future BLOCKED-wiring can read
  it. For M1, `onStale`/`onRecover` log at warn/info.
- The §10 "TP/SL feed fallback to REST" note is a tick-monitor concern (later milestone) — the
  monitor exposes the state that fallback will act on; the fallback itself is out of scope here.

## Worker wiring

`apps/worker/src/main.ts` (only on real boot, not tests) constructs a `BybitAdapter` for
`DEFAULT_PERP_SYMBOLS` × the MVP timeframes, starts the WS subscriptions + the poller, and
registers all feeds with a `FeedMonitor` whose `check()` runs on a small interval. Graceful
shutdown closes the WS, stops the poller and the monitor interval before the existing bus/db
teardown.

## Testing (catastrophic-if-wrong + seams)

Unit (pure, no network):
- kline normalization incl. the `confirm` gate (a forming candle is not persistable).
- ticker delta-merge: a delta missing `fundingRate` doesn't wipe the last-known value; funding
  + OI both extracted.
- liquidation + account-ratio normalization.
- topic builders + interval mapping round-trip.
- REST envelope: `retCode !== 0` throws; a good `result.list` parses via normalize.
- **FeedMonitor** with an injected clock: not stale before threshold; stale at/after; recover on
  heartbeat; kline `2×interval+30s` values correct for each timeframe.

Integration (live, guarded):
- Postgres: persisting the same closed candle twice → one row (`onConflictDoNothing`), funding +
  OI upserts idempotent. (Live DB, skipIf no DATABASE_URL — reuses change 1's pattern.)
- Bybit REST (opt-in, `BYBIT_LIVE=1`): `getKlines('BTCUSDT','1m',{limit:5})` returns 5 parsed
  candles. Off by default — public but network-flaky; not in the default suite.

WS is tested via a fake socket injected into `BybitWsClient` (no live socket in unit tests);
a full live WS smoke is manual (documented in tasks), not in the automated suite.
