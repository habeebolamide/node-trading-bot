# Design: m1-replay-engine

Read §25 and rules 11/21/22 alongside.

## No-look-ahead, enforced structurally (rule 21)

The whole risk §25 guards against is a replay path reading data it couldn't have known at T.
The guard here is a *type*, not a convention:

```
AsOfMarketData(db, asOf: Date)
  candlesAsOf(symbol, tf, limit)   → open_time ≤ asOf, newest `limit`, ascending
  fundingAsOf(symbol, limit)       → funding_time ≤ asOf
  openInterestAsOf(symbol, limit)  → snapshot_time ≤ asOf
```

There is deliberately **no** `latest()` / `current()` method. A consumer bound to an
`AsOfMarketData` literally cannot ask for data beyond `asOf`; the only way to advance is for the
ReplayEngine to hand it a new view at a later T. This is §25's "the backtest data-access layer
must not expose a current-score method that could be called by mistake," applied at M1 to market
data (wallet scores don't exist yet — M2 adds its own as-of reader following this pattern).

## Reader (local Postgres only, §25)

`HistoricalMarketReader` queries `market_candle` / `funding_rate` / `open_interest` via Drizzle,
ordered by time. `streamCandles` is an async generator that pages through the range in ascending
`open_time` chunks (keyset pagination on `open_time` to bound memory over millions of rows) so a
year-long replay doesn't load everything at once. Never calls Bybit — reproducibility (§25):
same stored rows → identical stream, on Monday and on Friday.

## ReplayEngine

```
for await (const bar of reader.streamCandles(symbol, primaryTf, {from, to})) {
  const asOf = bar.closeTime;              // T — info available at candle close
  yield { asOf, bar, data: new AsOfMarketData(db, asOf) };
}
```

Deterministic and stateless beyond the cursor. M4–M6 consume `{asOf, bar, data}` to run agents
and score — but that hookup is out of scope; here the contract + determinism are the deliverable.

## Backfill (idempotent, forward pagination)

Bybit kline returns ≤1000 rows for a `[start,end]` window. `backfillKlines` walks **forward**:

```
cursor = fromMs
loop:
  batch = rest.getKlines(symbol, tf, { start: cursor, end: toMs, limit: 1000 })  // client sorts ascending
  if batch empty → break
  upsert batch (onConflictDoNothing — re-runs and overlap are no-ops, §29)
  if batch.length < 1000 → break            // last page
  cursor = lastOpenTime + timeframeMs(tf)    // advance past the last candle
  (small delay between calls — be nice to the API)
```

`backfillFunding` / `backfillOpenInterest` follow the same forward-window shape against their
endpoints (funding is sparse ~3/day; OI defaults to `1h` granularity). All upserts
`onConflictDoNothing` on the tables' composite PKs, so backfill is safely re-runnable and can
resume after an interruption by just running again over the same range.

The pagination/advance logic is pure enough to unit-test with a **fake `BybitRestClient`** that
returns canned pages (assert: forward progress, stops on a short page, no infinite loop, upserts
every row), plus a fake db capturing inserts — no network in unit tests.

## scripts workspace

`scripts/backfill-bybit.ts`: parse argv (`--symbols`, `--timeframes`, `--months`, `--oi-interval`),
`loadEnv()` + `getConfig()`, build `BybitRestClient({testnet})` + `getDb()`, then run the three
backfills per symbol×timeframe, logging progress + row counts. `scripts` becomes an npm workspace
(added to the root globs) so `@tip/*` imports resolve; it imports the built `dist`, so it runs
after `npm run build`. An npm script `backfill` wraps `tsx src/backfill-bybit.ts`.

## Testing

Unit (no network):
- `backfillKlines` pagination with a fake rest: three canned pages → forward progress, stops on
  the short final page, every row upserted, no re-fetch loop. Fake db records values.
- `AsOfMarketData` filter semantics via a fake/real db: a row at `T+1` is never returned by an
  `asOf = T` view (the rule-21 assertion).

Integration (live Postgres, skipIf no DATABASE_URL):
- seed a handful of candles out of order → `streamCandles` yields them ascending; `ReplayEngine`
  yields one `{asOf,bar,data}` per bar with `asOf === bar.closeTime`; `data.candlesAsOf` at an
  early bar excludes later-timed candles (no look-ahead). Cleanup by unique test symbol.

Live smoke (manual, documented): run the CLI for a small real range (e.g. 1 day of 1h BTCUSDT)
and confirm rows land + a re-run adds zero. NOT the full 6-month load.
