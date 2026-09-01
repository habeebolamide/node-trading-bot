# Change: m1-replay-engine

> **COMPLETED 2026-09-01 — final M1 change; M1 (Data Foundation) is now complete.** Shipped
> `packages/evaluation`: `AsOfMarketData` (no-look-ahead view — candles filtered on `closeTime ≤ T`
> so a bar isn't observable until it closes; no `latest()` escape hatch, rule 21), a keyset-paginated
> `HistoricalMarketReader.streamCandles`, and `ReplayEngine.replay()` yielding `{asOf=bar.closeTime,
> bar, data}` per primary-TF bar — reading local Postgres only (§25 reproducibility). Plus
> `backfill.ts` (klines/funding/OI, forward-paginated, `onConflictDoNothing` = idempotent/resumable)
> and a new `scripts` workspace with `backfill-bybit.ts` CLI.
>
> **Verified:** typecheck green; **66/69 tests pass** (3 opt-in live skipped). Backfill pagination
> unit-tested (forward progress, stop-on-short-page, no infinite loop); replay ordering +
> no-look-ahead verified against live Postgres (out-of-order insert → ascending stream; first bar's
> view excludes future candles). Live CLI smoke against real Bybit: 1.5 days of 1h BTCUSDT inserted
> 36 klines / 4 funding / 36 OI; an immediate re-run inserted 0 (idempotent).
>
> **Full pre-launch backfill command** (operational, not run here — long + API-heavy; §30 wants ≥6
> months for BTC/ETH/SOL before Brain Seeding at M6):
> ```
> npm run build
> npm run backfill --workspace @tip/scripts -- \
>   --symbols=BTCUSDT,ETHUSDT,SOLUSDT --timeframes=1m,5m,15m,1h,4h,1d --months=6 --oi-interval=1h
> ```
>
> **Deviations from spec:** none material. As designed: no agent/signal/prediction hookup on the
> loop (M4–M6), no Brain Seeding run (M6 gate), no memecoin replay, 1m granularity (true-tick is a
> later refinement). Solo: OI backfill defaults to `1h` granularity (5-min over 6mo is ~52k
> rows/symbol); `candlesAsOf` filters on `closeTime` (corrected from `openTime` during build to
> avoid leaking the just-opened bar).

**Status:** COMPLETED — archived
**Original status:** PROPOSED (building straight through)
**Milestone:** M1 — Data Foundation (§30), change 4 of 4 (final)
**Implements:** §25 (historical store in local Postgres, chronological replay, no live fetch at
replay time), §30 correction (core replay engine is M1, not M6), §33 rules 11/21/22 (no
look-ahead — structural). Reuses the change-2 `BybitRestClient` for backfill.

## Why

Brain Seeding (§25) needs to replay history *before* the system trades live, so the core replay
engine is foundational M1 infrastructure, not an M6 evaluation nicety. This change builds:

1. the **backfill** that loads Bybit REST history (klines/funding/OI) into the local historical
   store — the same tables live WS ingestion extends (§25 "one table"); and
2. the **core replay engine**: a chronological, local-Postgres-only reader that yields historical
   bars in order and hands each step a **no-look-ahead** data view (only data with `timestamp ≤ T`),
   with no "current/latest" escape hatch to violate rule 21 by accident.

M4–M6 attach agents/signals/predictions on top of this loop; M1 delivers the loop + the data.

## What changes

New package **`packages/evaluation`**:

- **`reader.ts`** — `HistoricalMarketReader`: `streamCandles(symbol, tf, {from,to})` (async
  generator, ascending), `candlesAsOf` / `fundingAsOf` / `openInterestAsOf` (rows with
  `time ≤ T` only). Reads local Postgres exclusively — never Bybit (§25 reproducibility).
- **`asof.ts`** — `AsOfMarketData`: a cursor-bound view constructed with a fixed `asOf` T; every
  method filters `≤ T`. **No method returns "latest" without a T** — the structural rule-21
  guard (the type simply doesn't expose one).
- **`replay.ts`** — `ReplayEngine.replay({symbol, primaryTf, from, to})`: async-iterates the
  primary-TF candles ascending and yields `{ asOf: bar.closeTime, bar, data: AsOfMarketData }`
  per step. Deterministic: same rows in → same sequence out (§25 reproducibility, Task 7).
- **`backfill.ts`** — `backfillKlines/backfillFunding/backfillOpenInterest(rest, db, …)`:
  paginate Bybit REST forward over a time range and upsert into `market_candle`/`funding_rate`/
  `open_interest` with `onConflictDoNothing` (idempotent — re-runs add nothing, §25/§29).

New **`scripts`** workspace: `backfill-bybit.ts` CLI wiring config + `BybitRestClient` + db +
the backfill functions (symbols/timeframes/range configurable; defaults to the §30 pre-launch
set — BTC/ETH/SOL, all six TFs, 6 months).

## What this change does NOT do

- **No agents/signals/predictions in the loop** — the replay engine yields bars + a no-look-ahead
  data view; wiring analysis onto it is M4–M6. Proving the loop + the reproducible no-look-ahead
  access is the M1 deliverable.
- **No Brain Seeding run** — seeding *uses* this engine, at the M6 pre-launch gate; not now.
- **No memecoin replay** — memecoin has no historical backtest/seeding in MVP (§25, deliberate).
- **No trade-tick upgrade** — 1m klines are the finest granularity (§25); true-tick seeding is a
  documented later refinement.
- **I will not run the full 6-month backfill here** — it's a long, API-heavy operational step. I
  verify the script end-to-end on a *small* real range and document the full command.

## Resolved solo (flag)

- Replay cursor `T = candle.closeTime` (data for a candle is available at its close, not open) —
  consistent with the §21 horizon-anchor reasoning about when information exists.
- OI backfill uses `1h` `intervalTime` by default (5-min over 6 months is ~52k rows/symbol; hourly
  is ample for seeding and far lighter). Tunable via the CLI.
- `scripts` added to the npm workspaces globs so the backfill runner resolves `@tip/*` (imports
  the built `dist`, so run after `npm run build`).
