/**
 * Benchmark reads (Task 7). Perp: the underlying's own buy-and-hold over the window (+ BTC beta
 * as a later refinement). Memecoin: SOL return over the window — memecoin holdings are quoted in
 * SOL on Solana, so "did the setup beat holding SOL?" is the honest benchmark. Reads from
 * `market_candle` SOLUSDT which M1's Bybit backfill already stores; no new provider needed
 * (Task 7 stated this exact source).
 */
import { and, asc, eq, gte, lte } from 'drizzle-orm';
import { marketCandle, type Db } from '@tip/database';
import type { Domain } from '@tip/trading-agents';

/** Return-over-window from the first bar's close (at or after `from`) to the last close ≤ `to`. */
async function candleReturn(db: Db, symbol: string, timeframe: string, from: Date, to: Date): Promise<number | null> {
  const rows = await db
    .select({ close: marketCandle.close, closeTime: marketCandle.closeTime })
    .from(marketCandle)
    .where(and(
      eq(marketCandle.symbol, symbol),
      eq(marketCandle.timeframe, timeframe),
      gte(marketCandle.closeTime, from),
      lte(marketCandle.closeTime, to),
    ))
    .orderBy(asc(marketCandle.closeTime));
  if (rows.length < 2) return null;
  const first = Number(rows[0]!.close);
  const last = Number(rows[rows.length - 1]!.close);
  if (first <= 0) return null;
  return (last - first) / first;
}

/**
 * Benchmark return for `domain` over `[from, to]` — the buy-and-hold ideal a directional bet
 * has to clear before alpha becomes positive.
 *
 * Perp: the traded symbol itself (perp beats holding = alpha positive).
 * Memecoin: SOL (a memecoin win that merely tracked SOL gets zero alpha).
 * The 1m timeframe is used for tight window measurement; falls back to null on absent data —
 * a NULL benchmark is honest ("we don't know"), and `alpha` stays null downstream (§21).
 */
export async function benchmarkReturn(db: Db, input: {
  domain: Domain; symbol: string; from: Date; to: Date;
}): Promise<number | null> {
  const sym = input.domain === 'memecoin' ? 'SOLUSDT' : input.symbol;
  return candleReturn(db, sym, '1m', input.from, input.to);
}
