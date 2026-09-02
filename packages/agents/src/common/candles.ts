/**
 * THE correct "last N candles as of T" read (audit-2 finding B1 — the candle-window bug).
 *
 * `ORDER BY open_time ASC LIMIT N` under a `close_time <= T` filter returns the OLDEST N rows
 * in the table — so once history outgrew N, every agent computed EMA/RSI/MACD/ATR on the same
 * ancient window from the start of the backfill, bar after bar (observed live: 300/300 seeded
 * steps NEUTRAL because the indicators never changed). Unit fixtures held < N rows, so tests
 * couldn't catch it.
 *
 * Correct idiom (same as evaluation/asof.ts): DESC + LIMIT to grab the newest N at T, then
 * reverse into chronological order for the indicator math. Every agent candle read goes through
 * here — do not inline candle queries in agents again.
 */
import { and, desc, eq, lte } from 'drizzle-orm';
import { marketCandle, type Db } from '@tip/database';

export interface CandleWindowRow {
  openTime: Date;
  high: string;
  low: string;
  close: string;
  volume: string;
}

/** Newest `limit` candles with closeTime ≤ `at`, returned CHRONOLOGICALLY (oldest first). */
export async function recentCandlesAsOf(
  db: Db, symbol: string, timeframe: string, at: Date, limit: number,
): Promise<CandleWindowRow[]> {
  const rows = await db
    .select({
      openTime: marketCandle.openTime, high: marketCandle.high, low: marketCandle.low,
      close: marketCandle.close, volume: marketCandle.volume,
    })
    .from(marketCandle)
    .where(and(eq(marketCandle.symbol, symbol), eq(marketCandle.timeframe, timeframe), lte(marketCandle.closeTime, at)))
    .orderBy(desc(marketCandle.openTime))
    .limit(limit);
  return rows.reverse();
}
