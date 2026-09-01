/**
 * One-time (and resumable) historical backfill of the Bybit REST history into the local store
 * (§25). Forward-paginates a time range and upserts with `onConflictDoNothing`, so overlap and
 * re-runs are no-ops — the backfill can resume after an interruption by simply running again.
 * Reuses `BybitRestClient` (change 2); this module never talks to Bybit itself beyond that seam.
 */
import type { MarketSymbol, Timeframe } from '@tip/domain';
import { marketCandle, fundingRate, openInterest, type Db } from '@tip/database';
import { type BybitRestClient } from '@tip/ingestion';

const KLINE_PAGE = 1000;
const HISTORY_PAGE = 200;

export interface BackfillResult {
  fetched: number;
  inserted: number;
}

export interface BackfillOptions {
  /** ms delay between REST calls (be polite to the API). Default 0 (tests); scripts pass ~150. */
  delayMs?: number;
}

const sleep = (ms: number): Promise<void> => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/** Backfill klines for one symbol/timeframe over [fromMs, toMs]. */
export async function backfillKlines(
  rest: BybitRestClient,
  db: Db,
  symbol: MarketSymbol,
  timeframe: Timeframe,
  fromMs: number,
  toMs: number,
  opts: BackfillOptions = {},
): Promise<BackfillResult> {
  let cursor = fromMs;
  let fetched = 0;
  let inserted = 0;
  for (;;) {
    const batch = await rest.getKlines(symbol, timeframe, { start: cursor, end: toMs, limit: KLINE_PAGE });
    if (batch.length === 0) break;
    fetched += batch.length;
    const rows = await db
      .insert(marketCandle)
      .values(
        batch.map((k) => ({
          symbol: k.symbol,
          timeframe: k.timeframe,
          openTime: k.openTime,
          closeTime: k.closeTime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume,
          turnover: k.turnover,
        })),
      )
      .onConflictDoNothing()
      .returning({ openTime: marketCandle.openTime });
    inserted += rows.length;
    if (batch.length < KLINE_PAGE) break;
    cursor = batch[batch.length - 1]!.openTime.getTime() + 1;
    await sleep(opts.delayMs ?? 0);
  }
  return { fetched, inserted };
}

/** Backfill funding-rate history for one symbol. */
export async function backfillFunding(
  rest: BybitRestClient,
  db: Db,
  symbol: MarketSymbol,
  fromMs: number,
  toMs: number,
  opts: BackfillOptions = {},
): Promise<BackfillResult> {
  let cursor = fromMs;
  let fetched = 0;
  let inserted = 0;
  for (;;) {
    const batch = await rest.getFundingHistory(symbol, { start: cursor, end: toMs, limit: HISTORY_PAGE });
    if (batch.length === 0) break;
    fetched += batch.length;
    const rows = await db
      .insert(fundingRate)
      .values(batch.map((f) => ({ symbol: f.symbol, fundingTime: f.fundingTime, rate: f.rate })))
      .onConflictDoNothing()
      .returning({ fundingTime: fundingRate.fundingTime });
    inserted += rows.length;
    if (batch.length < HISTORY_PAGE) break;
    cursor = batch[batch.length - 1]!.fundingTime.getTime() + 1;
    await sleep(opts.delayMs ?? 0);
  }
  return { fetched, inserted };
}

/** Backfill open-interest history for one symbol at the given interval (default 1h). */
export async function backfillOpenInterest(
  rest: BybitRestClient,
  db: Db,
  symbol: MarketSymbol,
  intervalTime: '5min' | '15min' | '30min' | '1h' | '4h' | '1d',
  fromMs: number,
  toMs: number,
  opts: BackfillOptions = {},
): Promise<BackfillResult> {
  let cursor = fromMs;
  let fetched = 0;
  let inserted = 0;
  for (;;) {
    const batch = await rest.getOpenInterest(symbol, intervalTime, { start: cursor, end: toMs, limit: HISTORY_PAGE });
    if (batch.length === 0) break;
    fetched += batch.length;
    const rows = await db
      .insert(openInterest)
      .values(batch.map((o) => ({ symbol: o.symbol, snapshotTime: o.snapshotTime, oi: o.oi })))
      .onConflictDoNothing()
      .returning({ snapshotTime: openInterest.snapshotTime });
    inserted += rows.length;
    if (batch.length < HISTORY_PAGE) break;
    cursor = batch[batch.length - 1]!.snapshotTime.getTime() + 1;
    await sleep(opts.delayMs ?? 0);
  }
  return { fetched, inserted };
}
