/**
 * Token OHLCV aggregation from `wallet_transaction` swaps. Memecoin tokens don't have their own
 * candle stream — we build one on demand for a mint at a given timeframe by bucketing the
 * observed swaps we ingested via Helius.
 *
 * Price = amountSol / tokenAmount per swap. Volume = Σ amountSol in the bucket. This is the
 * same observed-swap approximation the wallet-scoring early-entry (M2 change 2) uses; consistent
 * with §25's "memecoin has no historical backtest/seeding" scope decision.
 */
import { and, asc, eq, gte, lte } from 'drizzle-orm';
import { walletTransaction, type Db } from '@tip/database';
import type { Timeframe } from '@tip/domain';

const TF_MS: Record<Timeframe, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

export interface TokenCandle {
  openTime: Date;
  closeTime: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volumeSol: number;
  tradeCount: number;
}

export interface BuildTokenCandlesOptions {
  since?: Date;
  until?: Date;
  /** Cap on candles returned (newest); default 200. */
  limit?: number;
}

/** Build closed OHLCV candles for one mint at one timeframe from the observed-swap store. */
export async function buildTokenCandles(
  db: Db,
  mint: string,
  timeframe: Timeframe,
  opts: BuildTokenCandlesOptions = {},
): Promise<TokenCandle[]> {
  const bucketMs = TF_MS[timeframe];
  const conds = [eq(walletTransaction.mint, mint)];
  if (opts.since) conds.push(gte(walletTransaction.blockTime, opts.since));
  if (opts.until) conds.push(lte(walletTransaction.blockTime, opts.until));

  const rows = await db
    .select({
      amountSol: walletTransaction.amountSol,
      tokenAmount: walletTransaction.tokenAmount,
      blockTime: walletTransaction.blockTime,
    })
    .from(walletTransaction)
    .where(and(...conds))
    .orderBy(asc(walletTransaction.blockTime));

  const buckets = new Map<number, TokenCandle>();
  for (const r of rows) {
    const sol = Number(r.amountSol);
    const tokens = Number(r.tokenAmount);
    if (sol <= 0 || tokens <= 0) continue;
    const price = sol / tokens;
    const openMs = Math.floor(r.blockTime.getTime() / bucketMs) * bucketMs;

    let c = buckets.get(openMs);
    if (!c) {
      c = {
        openTime: new Date(openMs),
        closeTime: new Date(openMs + bucketMs),
        open: price, high: price, low: price, close: price,
        volumeSol: 0, tradeCount: 0,
      };
      buckets.set(openMs, c);
    }
    c.high = Math.max(c.high, price);
    c.low = Math.min(c.low, price);
    c.close = price;
    c.volumeSol += sol;
    c.tradeCount += 1;
  }

  const asc_ = [...buckets.values()].sort((a, b) => a.openTime.getTime() - b.openTime.getTime());
  const limit = opts.limit ?? 200;
  return asc_.slice(Math.max(0, asc_.length - limit));
}
