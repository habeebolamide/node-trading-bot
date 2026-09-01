# Tasks: m1-replay-engine

`[x]` done

## 1. packages/evaluation
- [x] package.json (`@tip/evaluation`, deps domain/database/ingestion) + tsconfig + root ref +
      vitest alias
- [x] `asof.ts` — `AsOfMarketData` (candlesAsOf filters closeTime≤T; fundingAsOf/openInterestAsOf;
      NO latest())
- [x] `reader.ts` — `HistoricalMarketReader` (streamCandles async gen, keyset paginated; asOf())
- [x] `replay.ts` — `ReplayEngine.replay()` yielding {asOf=bar.closeTime, bar, data} per bar
- [x] `backfill.ts` — backfillKlines/backfillFunding/backfillOpenInterest (forward paginate,
      onConflictDoNothing, delay between calls)
- [x] index.ts barrel

## 2. scripts workspace
- [x] added `scripts` to root workspaces globs + root tsconfig ref
- [x] `scripts/package.json` (`@tip/scripts`) + tsconfig
- [x] `scripts/src/backfill-bybit.ts` — argv-configurable CLI; `backfill` npm script

## 3. Tests
- [x] unit: backfillKlines pagination (3 pages → forward, stop on short page, all upserted, no
      infinite loop) + empty-range case
- [x] integration (live DB): out-of-order seed → streamCandles ascending; ReplayEngine
      asOf==closeTime; first-bar view excludes future candles (rule 21); last-bar sees all

## 4. Verify
- [x] typecheck + full suite green (66 pass, 3 opt-in skipped)
- [x] live CLI smoke: 1.5 days of 1h BTCUSDT → inserted 36 klines / 4 funding / 36 OI; re-run
      inserted 0 (idempotent). Full pre-launch load command documented in the script header +
      summary below.

## 5. Wrap-up
- [x] ARCHIVE → `openspec/archive/2026-09-01-m1-replay-engine/` + summary. **M1 (all 4 changes)
      COMPLETE.**
