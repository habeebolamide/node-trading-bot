/**
 * Reads the historical store (local Postgres) chronologically. NEVER calls a provider at replay
 * time (§25 reproducibility): the same stored rows yield the same stream on every run. Candle
 * streaming is keyset-paginated so a multi-year replay bounds memory instead of loading millions
 * of rows at once.
 */
import { and, eq, gte, lte, asc } from 'drizzle-orm';
import type { MarketSymbol, Timeframe } from '@tip/domain';
import { marketCandle, type Db } from '@tip/database';
import { AsOfMarketData, type Candle } from './asof.js';

const BATCH = 1000;

export interface StreamRange {
  from?: Date;
  to?: Date;
}

export class HistoricalMarketReader {
  constructor(private readonly db: Db) {}

  /** Async-iterate closed candles for (symbol, timeframe) ascending by open time, in [from, to]. */
  async *streamCandles(symbol: MarketSymbol, timeframe: Timeframe, range: StreamRange = {}): AsyncGenerator<Candle> {
    let cursor = range.from ?? new Date(0);
    for (;;) {
      const conds = [
        eq(marketCandle.symbol, symbol),
        eq(marketCandle.timeframe, timeframe),
        gte(marketCandle.openTime, cursor),
      ];
      if (range.to) conds.push(lte(marketCandle.openTime, range.to));

      const batch = await this.db
        .select()
        .from(marketCandle)
        .where(and(...conds))
        .orderBy(asc(marketCandle.openTime))
        .limit(BATCH);

      if (batch.length === 0) return;
      for (const row of batch) yield row;
      if (batch.length < BATCH) return; // last page
      // advance past the last row (openTime is unique per symbol+tf, so +1ms is safe)
      cursor = new Date(batch[batch.length - 1]!.openTime.getTime() + 1);
    }
  }

  /** A no-look-ahead view bound to T. */
  asOf(t: Date): AsOfMarketData {
    return new AsOfMarketData(this.db, t);
  }
}
