/**
 * A market-data view bound to a fixed point in time `asOf` (T). Every method returns only rows
 * with `time ≤ asOf` — the structural no-look-ahead guard (rule 21/§25). There is deliberately
 * NO `latest()` / `current()` method: a consumer holding an AsOfMarketData cannot ask for data
 * beyond T even by accident. To see later data, the ReplayEngine must hand it a new view at a
 * later T.
 */
import { and, eq, lte, asc } from 'drizzle-orm';
import type { MarketSymbol, Timeframe } from '@tip/domain';
import { marketCandle, fundingRate, openInterest, type Db } from '@tip/database';

export type Candle = typeof marketCandle.$inferSelect;
export type Funding = typeof fundingRate.$inferSelect;
export type OpenInterestRow = typeof openInterest.$inferSelect;

export class AsOfMarketData {
  constructor(
    private readonly db: Db,
    /** The cursor T. No data with a timestamp after this is observable through this view. */
    readonly asOf: Date,
  ) {}

  /**
   * Up to `limit` most-recent candles that have CLOSED at or before T, ascending by open time.
   * The filter is on `closeTime` (not `openTime`): a candle's data isn't known until it closes,
   * so a bar opening exactly at T must not be observable yet — that would be look-ahead (rule 21).
   */
  async candlesAsOf(symbol: MarketSymbol, timeframe: Timeframe, limit = 200): Promise<Candle[]> {
    const rows = await this.db
      .select()
      .from(marketCandle)
      .where(
        and(
          eq(marketCandle.symbol, symbol),
          eq(marketCandle.timeframe, timeframe),
          lte(marketCandle.closeTime, this.asOf),
        ),
      )
      .orderBy(asc(marketCandle.openTime));
    // ascending; take the last `limit` (most recent at/under T)
    return rows.slice(Math.max(0, rows.length - limit));
  }

  async fundingAsOf(symbol: MarketSymbol, limit = 100): Promise<Funding[]> {
    const rows = await this.db
      .select()
      .from(fundingRate)
      .where(and(eq(fundingRate.symbol, symbol), lte(fundingRate.fundingTime, this.asOf)))
      .orderBy(asc(fundingRate.fundingTime));
    return rows.slice(Math.max(0, rows.length - limit));
  }

  async openInterestAsOf(symbol: MarketSymbol, limit = 100): Promise<OpenInterestRow[]> {
    const rows = await this.db
      .select()
      .from(openInterest)
      .where(and(eq(openInterest.symbol, symbol), lte(openInterest.snapshotTime, this.asOf)))
      .orderBy(asc(openInterest.snapshotTime));
    return rows.slice(Math.max(0, rows.length - limit));
  }
}
